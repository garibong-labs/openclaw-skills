"""Private, attempt-bound failure receipt and read-only browser/login probe."""
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urljoin


def record_pre_submit_failure(env, reason, blog, category, port):
    nonce = env.get('TISTORY_PRE_SUBMIT_NONCE', '')
    destination = env.get('TISTORY_PRE_SUBMIT_RECEIPT', '')
    if (not re.fullmatch('[0-9a-f]{32}', nonce) or not destination
            or not Path(destination).is_absolute()
            or reason not in ('cdp-attach-failed', 'initial-og-render-failed')):
        return
    receipt = {'version': 1, 'nonce': nonce, 'reason': reason, 'submitStarted': False,
               'target': [blog, category, port]}
    try:
        # Never replace prior evidence. Incomplete writes are rejected by the caller.
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(receipt, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError:
        pass  # Do not replace the original publish failure with a receipt error.


class ManagementLinks(HTMLParser):
    def __init__(self, target):
        super().__init__()
        self.target = target
        self.links = set()

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            href = dict(attrs).get('href')
            if href:
                self.links.add(urljoin(self.target, href))


def authenticated_management(context, request_factory, blog):
    root = f'https://{blog}'
    target = root + '/manage/posts/'
    # Scope existing cookies to the requested URL and keep any response cookies
    # in an in-memory request context, never in the attached browser profile.
    cookies = context.cookies([target])
    if not cookies:
        return False
    request = request_factory.new_context(storage_state={'cookies': cookies, 'origins': []})
    try:
        response = request.get(target, timeout=4000, max_redirects=0,
                               headers={'Cache-Control': 'no-cache'})
        if response.status != 200 or response.url != target:
            return False
        if 'text/html' not in response.headers.get('content-type', '').lower():
            return False
        body = response.body()
    finally:
        request.dispose()
    if len(body) > 2 * 1024 * 1024:
        return False
    page = ManagementLinks(target)
    page.feed(body.decode('utf-8'))
    return (target in page.links
            and bool({root + '/manage/newpost/', root + '/manage/newpost/?type=post'} & page.links))


def browser_ready(chromium, request_factory, blog, port):
    if (not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.tistory\.com', blog)
            or not 1 <= port <= 65535):
        return False
    # Use the same first context as the publisher. No editor GET, new tabs,
    # login commands, shared-cookie changes, browser.close, or publish actions.
    try:
        browser = chromium.connect_over_cdp(f'http://127.0.0.1:{port}', timeout=4000)
        return bool(browser.contexts) and authenticated_management(browser.contexts[0], request_factory, blog)
    except Exception:
        return False


def main(argv):
    if len(argv) != 3 or argv[0] != '--probe':
        return 2
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            if browser_ready(playwright.chromium, playwright.request, argv[1], int(argv[2])):
                print('tistory-management-ready-v1')
                return 0
    except Exception:
        pass
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
