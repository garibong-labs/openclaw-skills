import ast
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from publish_recovery import browser_ready, record_pre_submit_failure


class PublishRecoveryTest(unittest.TestCase):
    def test_embedded_failure_handler_emits_only_in_explicit_public_daum_scope(self):
        script = Path(__file__).resolve().parents[1] / 'scripts' / 'publish-post.sh'
        source = script.read_text().split("<< 'PYTHON_SCRIPT'\n", 1)[1].split('\nPYTHON_SCRIPT\n', 1)[0]
        fail = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef)
                    and node.name == 'fail')
        code = compile(ast.Module(body=[fail], type_ignores=[]), 'publish-failure', 'exec')
        for template, private, scope, expected in (
                ('daum-trends', False, 'cdp-attach-failed', True),
                ('daum-trends', False, 'initial-og-render-failed', True),
                ('daum-trends', False, None, False),
                ('daum-trends', True, 'cdp-attach-failed', False),
                ('mk-review', False, 'cdp-attach-failed', False)):
            with self.subTest(template=template, private=private, scope=scope):
                emit = Mock()
                ns = dict(TEMPLATE=template, PRIVATE=private, pre_submit_failure_scope=scope,
                          BLOG='sample.tistory.com', CATEGORY='Sample', CDP_PORT='12345',
                          record_pre_submit_failure=emit, os=os, json=json, sys=sys, print=Mock())
                exec(code, ns)
                with self.assertRaises(SystemExit) as error:
                    ns['fail']('controlled failure')
                self.assertEqual(error.exception.code, 1)
                self.assertEqual(emit.call_count, int(expected))

    def test_receipt_is_scoped_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'receipt.json'
            env = {'TISTORY_PRE_SUBMIT_NONCE': 'f' * 32, 'TISTORY_PRE_SUBMIT_RECEIPT': str(path)}
            target = ('sample.tistory.com', 'Sample', '12345')
            record_pre_submit_failure(env, 'post-submit', *target)
            record_pre_submit_failure({}, 'cdp-attach-failed', *target)
            self.assertFalse(path.exists())
            record_pre_submit_failure(env, 'cdp-attach-failed', *target)
            record_pre_submit_failure(env, 'initial-og-render-failed', *target)
            self.assertEqual(json.loads(path.read_text()), {'version': 1, 'nonce': 'f' * 32,
                             'reason': 'cdp-attach-failed', 'submitStarted': False, 'target': list(target)})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_readiness_requires_same_blog_management_and_positive_login_evidence(self):
        blog = 'sample.tistory.com'
        target = f'https://{blog}/manage/posts/'
        body = b'<nav><a href="/manage/posts/">Posts</a><a href="/manage/newpost/?type=post">Write</a></nav>'
        for status, url, payload, expected in (
                (200, target, body, True),
                (302, target, body, False),
                (200, 'https://other.tistory.com/manage/posts/', body, False),
                (200, target, b'<form>Login</form>', False),
                (200, target, b'<a href="/manage/posts/">Posts</a>', False)):
            with self.subTest(status=status, url=url, payload=payload):
                response = SimpleNamespace(status=status, url=url, headers={'content-type': 'text/html'},
                                           body=lambda: payload)
                request = Mock()
                request.get.return_value = response
                cookies = [{'name': 'fixture', 'value': 'synthetic'}]
                context = Mock()
                context.cookies.return_value = cookies
                request_factory = Mock()
                request_factory.new_context.return_value = request
                chromium = Mock()
                chromium.connect_over_cdp.return_value = SimpleNamespace(contexts=[context])
                self.assertIs(browser_ready(chromium, request_factory, blog, 12345), expected)
                context.cookies.assert_called_once_with([target])
                request_factory.new_context.assert_called_once_with(storage_state={'cookies': cookies, 'origins': []})
                request.dispose.assert_called_once_with()
                request.get.assert_called_once_with(target, timeout=4000, max_redirects=0,
                                                    headers={'Cache-Control': 'no-cache'})

    def test_untrusted_target_or_attach_failure_is_not_ready(self):
        chromium = Mock()
        request_factory = Mock()
        self.assertFalse(browser_ready(chromium, request_factory, 'sample.tistory.com@other.test', 12345))
        chromium.connect_over_cdp.assert_not_called()
        chromium.connect_over_cdp.side_effect = TimeoutError
        self.assertFalse(browser_ready(chromium, request_factory, 'sample.tistory.com', 12345))
        request_factory.new_context.assert_not_called()
