"""Offline AST tests: no credential files, Playwright import, CDP or network."""
import ast
from pathlib import Path
import re
import unittest
from urllib.parse import urlsplit


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'login.sh'
EXPECTED = 'owner@example.test'
PASSWORD = 'synthetic-password'
DOMAINS = ['auth/login', 'accounts.kakao.com', 'logins.daum.net', 'kauth.kakao.com']
SIMPLE = 'https://accounts.kakao.com/login/simple/'
FORM = 'https://accounts.kakao.com/login/'
AUTH = 'https://blog.example.test/manage/newpost/'


class Clock:
    def __init__(self):
        self.now = 0
        self.sleeps = []
        self.on_sleep = None

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds
        if self.on_sleep:
            self.on_sleep(self.now)


class Element:
    def __init__(self, text='', visible=True, enabled=True, action=None):
        self.text, self.visible, self.enabled = text, visible, enabled
        self.action = action
        self.clicks = 0
        self.fills = []

    def is_visible(self):
        return self.visible

    def is_enabled(self):
        return self.enabled

    def inner_text(self, **kwargs):
        return self.text

    def click(self, **kwargs):
        self.clicks += 1
        if self.action:
            self.action()

    def fill(self, value, **kwargs):
        self.fills.append(value)
        if self.action:
            self.action()


class Locator:
    def __init__(self, elements):
        self.elements = elements

    def count(self):
        return len(self.elements)

    def nth(self, index):
        return self.elements[index]

    @property
    def first(self):
        return self.nth(0)

    def inner_text(self, **kwargs):
        return self.first.inner_text(**kwargs)


class Page:
    def __init__(self, url=SIMPLE, buttons=()):
        self.url = url
        self.buttons = list(buttons)
        self.body = Element()
        self.challenges = []
        self.id = Element()
        self.password = Element()
        self.submit = Element(action=lambda: self.transition(AUTH))
        self.has_form = url == FORM

    def transition(self, url):
        self.url = url
        self.has_form = url == FORM

    def locator(self, selector):
        if selector == 'body':
            return Locator([self.body])
        if selector == 'button':
            return Locator(self.buttons)
        if selector.startswith('iframe'):
            return Locator(self.challenges)
        if selector.startswith('input[placeholder'):
            return Locator([self.id] if self.has_form else [])
        if selector.startswith('input[type="password"]'):
            return Locator([self.password] if self.has_form else [])
        if selector.startswith('button[type="submit"]'):
            return Locator([self.submit])
        raise AssertionError('Unexpected selector')


class SimpleLoginTests(unittest.TestCase):
    def setUp(self):
        source = re.search(r"<< 'PYTHON_SCRIPT'\n(.*?)\nPYTHON_SCRIPT", SCRIPT.read_text(), re.S).group(1)
        tree = ast.parse(source)
        nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))]
        self.clock = Clock()
        self.ns = {'time': self.clock, 're': re, 'urlsplit': urlsplit}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SCRIPT), 'exec'), self.ns)
        self.stopped = self.ns['LoginStopped']

    def run_login(self, page):
        self.ns['complete_kakao_login'](page, EXPECTED, PASSWORD, DOMAINS)

    def assert_stops(self, page):
        with self.assertRaises(self.stopped) as caught:
            self.run_login(page)
        message = str(caught.exception)
        for secret in (EXPECTED, PASSWORD, 'other@example.test', page.body.text or 'private-marker'):
            self.assertNotIn(secret, message)
        return message

    def assert_no_credentials(self, page):
        self.assertEqual(page.id.fills, [])
        self.assertEqual(page.password.fills, [])
        self.assertEqual(page.submit.clicks, 0)

    def test_unique_exact_account_with_decoys_then_form(self):
        page = Page()
        exact = Element('Synthetic Owner\n' + EXPECTED, action=lambda: page.transition(FORM))
        decoys = [Element('other@example.test'), Element('own***@example.test'),
                  Element('다른 계정으로 로그인'), Element('계정 삭제')]
        page.buttons = decoys + [exact]
        self.run_login(page)
        self.assertEqual(exact.clicks, 1)
        self.assertTrue(all(b.clicks == 0 for b in decoys))
        self.assertEqual(page.id.fills, [EXPECTED])
        self.assertEqual(page.password.fills, [PASSWORD])
        self.assertEqual(page.submit.clicks, 1)
        self.assertEqual(page.url, AUTH)

    def test_no_matching_account_stops_without_alternate_click(self):
        page = Page(buttons=[Element('other@example.test'), Element('다른 계정으로 로그인')])
        self.assert_stops(page)
        self.assertTrue(all(b.clicks == 0 for b in page.buttons))
        self.assert_no_credentials(page)

    def test_delayed_option_insertion_selects_exact_account_once(self):
        decoy = Element('다른 계정으로 로그인')
        page = Page(buttons=[decoy])
        exact = Element('Name\n' + EXPECTED, action=lambda: page.transition(AUTH))
        self.clock.on_sleep = lambda now: setattr(page, 'buttons', [decoy, exact]) if now >= 0.75 else None
        self.run_login(page)
        self.assertEqual(self.clock.sleeps, [0.25, 0.5])
        self.assertEqual((exact.clicks, decoy.clicks), (1, 0))
        self.assert_no_credentials(page)

    def test_delayed_enabling_selects_exact_account_once(self):
        page = Page()
        exact = Element(EXPECTED, enabled=False, action=lambda: page.transition(AUTH))
        page.buttons = [exact]
        self.clock.on_sleep = lambda now: setattr(exact, 'enabled', True) if now >= 1.75 else None
        self.run_login(page)
        self.assertEqual(self.clock.sleeps, [0.25, 0.5, 1.0])
        self.assertEqual(exact.clicks, 1)
        self.assert_no_credentials(page)

    def test_delayed_ambiguous_options_stop_immediately_without_selection(self):
        page = Page()
        options = [Element(EXPECTED), Element('Name\n' + EXPECTED)]
        self.clock.on_sleep = lambda now: setattr(page, 'buttons', options)
        self.assert_stops(page)
        self.assertEqual(self.clock.sleeps, [0.25])
        self.assertTrue(all(b.clicks == 0 for b in options))
        self.assert_no_credentials(page)

    def test_challenge_during_readiness_prevents_ready_account_selection(self):
        for control in (False, True):
            with self.subTest(control=control):
                page = Page()
                exact = Element(EXPECTED)
                def appear(now):
                    page.buttons = [exact]
                    if control:
                        page.challenges = [Element()]
                    else:
                        page.body.text = '추가 인증'
                self.clock.on_sleep = appear
                self.assertIn('사용자 인증', self.assert_stops(page))
                self.assertEqual(exact.clicks, 0)
                self.assert_no_credentials(page)

    def test_redirect_during_readiness_to_form_or_authenticated(self):
        for destination in (FORM, AUTH):
            with self.subTest(destination=destination):
                exact = Element(EXPECTED, enabled=False)
                page = Page(buttons=[exact])
                def redirect(now):
                    exact.enabled = True  # 이전 화면의 버튼이 남아 있어도 선택 금지
                    page.transition(destination)
                self.clock.on_sleep = redirect
                self.run_login(page)
                self.assertEqual(exact.clicks, 0)
                if destination == FORM:
                    self.assertEqual(page.id.fills, [EXPECTED])
                    self.assertEqual(page.password.fills, [PASSWORD])
                    self.assertEqual(page.submit.clicks, 1)
                else:
                    self.assert_no_credentials(page)

    def test_challenge_on_redirect_during_readiness_stops_before_form(self):
        page = Page()
        def redirect(now):
            page.transition(FORM)
            page.body.text = 'CAPTCHA'
        self.clock.on_sleep = redirect
        self.assertIn('사용자 인증', self.assert_stops(page))
        self.assert_no_credentials(page)

    def test_readiness_deadline_exhaustion_uses_bounded_backoff(self):
        page = Page(buttons=[Element('다른 계정으로 로그인')])
        self.assert_stops(page)
        self.assertEqual(self.clock.now, 15)
        self.assertEqual(self.clock.sleeps, [0.25, 0.5] + [1.0] * 14 + [0.25])
        self.assertEqual(page.buttons[0].clicks, 0)
        self.assert_no_credentials(page)

    def test_option_arriving_at_deadline_is_not_selected(self):
        page = Page()
        exact = Element(EXPECTED, action=lambda: page.transition(AUTH))
        self.clock.on_sleep = lambda now: setattr(page, 'buttons', [exact]) if now >= 15 else None
        self.assert_stops(page)
        self.assertEqual(self.clock.now, 15)
        self.assertEqual(exact.clicks, 0)
        self.assert_no_credentials(page)

    def test_unresolved_redirect_during_readiness_keeps_original_deadline(self):
        page = Page()
        self.clock.on_sleep = lambda now: page.transition('https://accounts.kakao.com/login/loading/')
        self.assert_stops(page)
        self.assertEqual(self.clock.now, 15)
        self.assert_no_credentials(page)

    def test_multiple_exact_matches_stop(self):
        page = Page(buttons=[Element(EXPECTED), Element('Name\n' + EXPECTED)])
        self.assert_stops(page)
        self.assertTrue(all(b.clicks == 0 for b in page.buttons))
        self.assert_no_credentials(page)

    def test_hidden_disabled_masked_partial_and_substring_are_ineligible(self):
        for button in (Element(EXPECTED, visible=False), Element(EXPECTED, enabled=False),
                       Element('own***@example.test'), Element('owner@example'),
                       Element('x' + EXPECTED), Element(EXPECTED + '.invalid'),
                       Element('Log in as ' + EXPECTED), Element('owner@\nexample.test')):
            with self.subTest(text=button.text):
                page = Page(buttons=[button])
                self.assert_stops(page)
                self.assertEqual(button.clicks, 0)
                self.assert_no_credentials(page)

    def test_hidden_exact_decoy_does_not_make_visible_exact_ambiguous(self):
        page = Page()
        visible = Element(EXPECTED, action=lambda: page.transition(AUTH))
        hidden = Element(EXPECTED, visible=False)
        page.buttons = [visible, hidden]
        self.run_login(page)
        self.assertEqual((visible.clicks, hidden.clicks), (1, 0))
        self.assert_no_credentials(page)

    def test_direct_form_preserved(self):
        page = Page(FORM)
        self.run_login(page)
        self.assertEqual(page.id.fills, [EXPECTED])
        self.assertEqual(page.password.fills, [PASSWORD])
        self.assertEqual(page.submit.clicks, 1)

    def test_already_authenticated_does_not_fill(self):
        page = Page(AUTH)
        self.run_login(page)
        self.assert_no_credentials(page)

    def test_selected_account_redirects_authenticated_without_fill(self):
        page = Page()
        button = Element(EXPECTED, action=lambda: page.transition(AUTH))
        page.buttons = [button]
        self.run_login(page)
        self.assertEqual(button.clicks, 1)
        self.assert_no_credentials(page)

    def test_human_challenges_before_selection(self):
        for text in ('CAPTCHA', '2단계 인증', '추가 인증', '본인 인증', '인증번호',
                     '보안 문자', '로봇이 아닙니다', 'Two-factor authentication', 'Verification code'):
            with self.subTest(challenge=text):
                button = Element(EXPECTED)
                page = Page(buttons=[button])
                page.body.text = text
                self.assert_stops(page)
                self.assertEqual(button.clicks, 0)
                self.assert_no_credentials(page)

    def test_visible_challenge_control_before_credentials(self):
        page = Page(FORM)
        page.challenges = [Element()]
        self.assert_stops(page)
        self.assert_no_credentials(page)

    def test_hidden_challenge_control_does_not_block_form(self):
        page = Page(FORM)
        page.challenges = [Element(visible=False)]
        self.run_login(page)
        self.assertEqual(page.submit.clicks, 1)

    def test_challenge_after_account_selection_before_credentials(self):
        page = Page()
        def select():
            page.transition(FORM)
            page.body.text = '추가 인증'
        button = Element(EXPECTED, action=select)
        page.buttons = [button]
        self.assert_stops(page)
        self.assertEqual(button.clicks, 1)
        self.assert_no_credentials(page)

    def test_challenge_after_id_before_password(self):
        page = Page(FORM)
        page.id.action = lambda: setattr(page.body, 'text', 'CAPTCHA')
        self.assert_stops(page)
        self.assertEqual(page.id.fills, [EXPECTED])
        self.assertEqual(page.password.fills, [])
        self.assertEqual(page.submit.clicks, 0)

    def test_challenge_after_password_before_submit(self):
        page = Page(FORM)
        page.password.action = lambda: setattr(page.body, 'text', '2단계 인증')
        self.assert_stops(page)
        self.assertEqual(page.submit.clicks, 0)

    def test_post_submit_challenge_stops_even_on_non_login_url(self):
        page = Page(FORM)
        def submit():
            page.transition(AUTH)
            page.body.text = 'Verification code'
        page.submit.action = submit
        self.assert_stops(page)
        self.assertEqual(page.submit.clicks, 1)

    def test_challenge_url_before_form(self):
        page = Page('https://accounts.kakao.com/mfa/')
        page.has_form = True
        self.assert_stops(page)
        self.assert_no_credentials(page)

    def test_selection_without_transition_is_bounded_and_never_reselected(self):
        button = Element(EXPECTED)
        page = Page(buttons=[button])
        self.assert_stops(page)
        self.assertEqual(button.clicks, 1)
        self.assert_no_credentials(page)
        self.assertLess(self.clock.now, 15.3)

    def test_submit_without_redirect_is_bounded_and_never_resubmitted(self):
        page = Page(FORM)
        page.submit.action = None
        self.assert_stops(page)
        self.assertEqual(page.submit.clicks, 1)
        self.assertLess(self.clock.now, 15.3)


if __name__ == '__main__':
    unittest.main()
