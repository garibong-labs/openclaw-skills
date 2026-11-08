#!/usr/bin/env bash
# login.sh — Tistory 카카오 로그인 세션 복구 스크립트
# publish.sh 실행 전 로그인 세션이 만료됐을 때 사용
#
# 사용:
#   bash scripts/login.sh --cred-file /path/to/credentials.json [--blog your-blog.tistory.com] [--cdp-port 18800]
#
# 자격증명 파일 형식 (JSON 또는 key: value):
#   {"email": "...", "password": "..."}
#   또는
#   email: ...
#   password: ...
#
# 환경변수로도 지정 가능:
#   TISTORY_CRED_FILE=/path/to/credentials.json

set -euo pipefail

CDP_PORT="${TISTORY_CDP_PORT:-18800}"
CRED_FILE="${TISTORY_CRED_FILE:-}"
BLOG="${TISTORY_BLOG:-}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --cdp-port) CDP_PORT="$2"; shift 2 ;;
    --cred-file) CRED_FILE="$2"; shift 2 ;;
    --blog) BLOG="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$CRED_FILE" ]]; then
  echo "❌ 자격증명 파일 미지정"
  echo "   사용: bash login.sh --cred-file /path/to/credentials.json"
  echo "   또는: TISTORY_CRED_FILE=/path/to/cred.json bash login.sh"
  exit 1
fi

if [[ ! -f "$CRED_FILE" ]]; then
  echo "❌ 자격증명 파일 없음: $CRED_FILE"
  exit 1
fi

python3 - "$CDP_PORT" "$CRED_FILE" "$BLOG" << 'PYTHON_SCRIPT'
import sys, json, time, re
from urllib.parse import urlsplit


class LoginStopped(Exception):
    pass


def guard_human_challenge(page):
    # 표시된 인증 요구만 검사하며 본문/URL/예외 원문은 출력하지 않는다.
    path = urlsplit(page.url).path.lower()
    challenge = page.locator(
        'iframe[src*="captcha" i], iframe[title*="challenge" i], '
        'iframe[title*="recaptcha" i], input[autocomplete="one-time-code"], '
        'input[name*="otp" i], input[name*="captcha" i], '
        '[id*="captcha" i], [class*="captcha" i]')
    text = page.locator('body').inner_text(timeout=2000)
    if (any(challenge.nth(i).is_visible() for i in range(challenge.count()))
            or re.search(r'/(?:captcha|challenge|two[-_]?step|2fa|mfa|verify)(?:/|$)', path)
            or re.search(r'captcha|2단계\s*인증|추가\s*인증|본인\s*인증|'
                         r'인증\s*번호|보안\s*문자|로봇이\s*아닙|'
                         r'two[- ](?:step|factor)|verification\s*code|verify\s+you\s+are\s+human',
                         text, re.I)):
        raise LoginStopped('사용자 인증이 필요합니다. 브라우저에서 직접 인증 후 다시 실행하세요.')


def is_simple_login(page):
    url = urlsplit(page.url)
    return url.hostname == 'accounts.kakao.com' and url.path.rstrip('/') == '/login/simple'


def login_form(page):
    ids = page.locator('input[placeholder*="이메일"]:visible, input[placeholder*="아이디"]:visible, '
                       'input[type="email"]:visible, input[name="loginId"]:visible')
    passwords = page.locator('input[type="password"]:visible')
    return ids, passwords


def select_simple_account(page, expected_id, login_domains):
    guard_human_challenge(page)
    if not expected_id or any(mark in expected_id for mark in ('*', '…', '•')):
        raise LoginStopped('완전한 예상 계정 식별자가 필요합니다. 자격증명 설정을 확인하세요.')
    deadline = time.monotonic() + 15
    delay = 0.25
    while True:
        guard_human_challenge(page)
        matches = []
        if time.monotonic() < deadline:
            if not any(x in page.url for x in login_domains):
                return 'authenticated'
            if not is_simple_login(page):
                ids, passwords = login_form(page)
                if ids.count() and passwords.count():
                    return 'form'
            else:
                buttons = page.locator('button')
                for i in range(buttons.count()):
                    button = buttons.nth(i)
                    if button.is_visible() and button.is_enabled():
                        # 표시된 독립 행의 전체 식별자만 허용한다.
                        if expected_id in [line.strip() for line in button.inner_text().splitlines()]:
                            matches.append(button)
        if len(matches) > 1 or time.monotonic() >= deadline:
            raise LoginStopped('간편로그인 계정을 유일하게 확인할 수 없습니다. '
                               '브라우저에서 예상 계정으로 직접 로그인 후 다시 실행하세요.')
        if len(matches) == 1:
            guard_human_challenge(page)
            # 검사 중 이동했다면 이전 화면의 버튼을 선택하지 않는다.
            if is_simple_login(page) and time.monotonic() < deadline:
                matches[0].click(timeout=5000)
                return 'selected'
        # 렌더링/활성화를 기다리되 제한 시간을 늘리거나 선택을 재시도하지 않는다.
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(delay, remaining))
            delay = min(delay * 2, 1.0)


def wait_login_state(page, login_domains, allow_simple=False, allow_form=True):
    deadline = time.monotonic() + 15
    while True:
        guard_human_challenge(page)
        if not any(x in page.url for x in login_domains):
            return 'authenticated'
        if allow_simple and is_simple_login(page):
            return 'simple'
        ids, passwords = login_form(page)
        if allow_form and not is_simple_login(page) and ids.count() and passwords.count():
            return 'form'
        if time.monotonic() >= deadline:
            raise LoginStopped('로그인 화면 전환을 확인하지 못했습니다. '
                               '브라우저에서 로그인 상태를 확인 후 다시 실행하세요.')
        time.sleep(0.2)


def complete_kakao_login(page, kakao_id, kakao_pw, login_domains):
    state = wait_login_state(page, login_domains, allow_simple=True)
    if state == 'simple':
        state = select_simple_account(page, kakao_id, login_domains)
        if state == 'selected':
            state = wait_login_state(page, login_domains)
    if state == 'authenticated':
        return
    guard_human_challenge(page)
    ids, passwords = login_form(page)
    ids.first.fill(kakao_id, timeout=5000)
    guard_human_challenge(page)
    passwords.first.fill(kakao_pw, timeout=5000)
    guard_human_challenge(page)
    page.locator('button[type="submit"]:visible, button:has-text("로그인"):visible').first.click(timeout=5000)
    wait_login_state(page, login_domains, allow_form=False)


CDP_PORT = sys.argv[1]
CRED_FILE = sys.argv[2]
BLOG = sys.argv[3].strip()
CDP_URL = f"http://127.0.0.1:{CDP_PORT}"
TARGET_URL = f"https://{BLOG}/manage/newpost/?type=post" if BLOG else "https://www.tistory.com/manage/newpost/?type=post"

with open(CRED_FILE) as f:
    content = f.read()
# Support both JSON and YAML-like (key: value) format
kakao_id = ""
kakao_pw = ""
try:
    cred = json.loads(content)
    kakao_id = cred.get("email") or cred.get("id") or ""
    kakao_pw = cred.get("password") or cred.get("pw") or ""
except json.JSONDecodeError:
    import re
    m_email = re.search(r'email:\s*(.+)', content)
    m_pw = re.search(r'password:\s*(.+)', content)
    if m_email: kakao_id = m_email.group(1).strip()
    if m_pw: kakao_pw = m_pw.group(1).strip()
if not kakao_id or not kakao_pw:
    print("❌ 자격증명 불완전 (email/password 필드 확인)")
    sys.exit(1)

from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(CDP_URL)
    ctx = browser.contexts[0] if browser.contexts else browser.new_context()
    page = ctx.new_page()

    print(f"[{time.strftime('%H:%M:%S')}] Tistory 로그인 확인: {TARGET_URL}")
    page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=20000)

    login_domains = ["auth/login", "accounts.kakao.com", "logins.daum.net", "kauth.kakao.com"]
    try:
        guard_human_challenge(page)
    except LoginStopped as exc:
        print(f"❌ {exc}")
        sys.exit(1)
    except Exception:
        print('❌ 로그인 화면을 확인하지 못했습니다. 브라우저에서 직접 확인 후 다시 실행하세요.')
        sys.exit(1)
    if not any(x in page.url for x in login_domains):
        print(f"✅ 이미 로그인됨 ({page.url})")
        try:
            page.close()
        except Exception:
            pass
        sys.exit(0)

    try:
        guard_human_challenge(page)
        # 카카오계정으로 로그인 버튼 클릭 (이미 카카오 화면이면 생략)
        if urlsplit(page.url).hostname != 'accounts.kakao.com':
            try:
                page.locator('a:has-text("카카오계정으로 로그인"), button:has-text("카카오계정으로 로그인")').first.click(timeout=5000)
                page.wait_for_url(lambda url: "kakao" in url, timeout=10000)
            except Exception:
                pass  # 아래 상태 확인에서 전환 실패도 제한 시간 내 중단
        complete_kakao_login(page, kakao_id, kakao_pw, login_domains)
        page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=20000)
        guard_human_challenge(page)
    except LoginStopped as exc:
        print(f"❌ {exc}")
        sys.exit(1)
    except Exception:
        # Playwright 예외에는 입력값/DOM이 포함될 수 있으므로 원문 출력 금지.
        print('❌ 로그인 자동화를 완료하지 못했습니다. 브라우저에서 로그인 상태를 확인 후 다시 실행하세요.')
        sys.exit(1)
    if any(x in page.url for x in login_domains):
        print('❌ 로그인 후에도 로그인 페이지 유지됨. 브라우저에서 직접 확인하세요.')
        sys.exit(1)
    print(f"✅ 로그인 성공 → {page.url}")
    page.close()
PYTHON_SCRIPT
