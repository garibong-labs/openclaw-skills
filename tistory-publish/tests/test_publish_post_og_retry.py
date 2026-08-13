"""Behavior tests for the publish-post.sh OG bounded retry and the
confirmed-40002 DCInside mobile/desktop paired fallback (2026-08-13 abort).

The publish engine is embedded Python inside a bash heredoc; like
test_publish_post_upload.py these tests extract the relevant functions via
ast and drive them with fakes. No network, no browser.
"""
import ast
import json
import re
import unittest
import warnings
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "publish-post.sh"
FUNCTION_NAMES = {
    "dcinside_paired_og_url",
    "scrap_response_matches",
    "classify_scrap_code",
    "summarize_scrap_responses",
    "og_backoff_delay_s",
    "ensure_og_helpers",
    "attempt_og_render",
    "render_og_card_with_fallback",
    "render_og_cards",
}

MOBILE_URL_2026_08_10 = "https://m.dcinside.com/board/ngm/270135"
DESKTOP_URL_2026_08_10 = "https://gall.dcinside.com/board/view/?id=ngm&no=270135"
MOBILE_URL_2026_08_13 = "https://m.dcinside.com/board/comic_new6/5734260"
DESKTOP_URL_2026_08_13 = "https://gall.dcinside.com/board/view/?id=comic_new6&no=5734260"


class PublishAbort(RuntimeError):
    pass


class FakeTime:
    def __init__(self):
        self.sleeps = []

    def sleep(self, seconds):
        self.sleeps.append(seconds)


def load_og_functions(overrides):
    shell_source = SCRIPT_PATH.read_text(encoding="utf-8")
    match = re.search(r"<< 'PYTHON_SCRIPT'\n(.*?)\nPYTHON_SCRIPT\n", shell_source, re.DOTALL)
    if not match:
        raise AssertionError("embedded Python publish script not found")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", SyntaxWarning)
        tree = ast.parse(match.group(1), filename=str(SCRIPT_PATH))
    selected = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name in FUNCTION_NAMES
    ]
    if {node.name for node in selected} != FUNCTION_NAMES:
        missing = FUNCTION_NAMES - {node.name for node in selected}
        raise AssertionError(f"OG helper functions not found in embedded Python: {missing}")
    namespace = {
        "re": re,
        "json": json,
        "urlsplit": urlsplit,
        "parse_qs": parse_qs,
        **overrides,
    }
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(SCRIPT_PATH), "exec"), namespace)
    return namespace


class FakeResponse:
    def __init__(self, url, status, body):
        self.url = url
        self.status = status
        self._body = body

    def text(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class FakeKeyboard:
    def __init__(self, page):
        self.page = page

    def press(self, key):
        assert key == "Enter"
        self.page.enter_presses += 1
        self.page.on_enter()


class FakePage:
    """Scripted page: each Enter press consumes one attempt entry
    {'responses': [FakeResponse...], 'status': og-card status dict}."""

    def __init__(self, attempts, helpers_ready=(True,), cleanup_og_cards=None):
        self.attempts = list(attempts)
        self.helpers_ready = list(helpers_ready)
        self.cleanup_og_cards = cleanup_og_cards
        self.keyboard = FakeKeyboard(self)
        self.enter_presses = 0
        self.listeners = []
        self.prepare_calls = []
        self.injected_helpers = []
        self.current_status = {"found": False, "ogCardCount": 0}

    def on(self, event, callback):
        assert event == "response"
        self.listeners.append(callback)

    def remove_listener(self, event, callback):
        assert event == "response"
        self.listeners.remove(callback)

    def add_script_tag(self, path=None):
        self.injected_helpers.append(path)

    def on_enter(self):
        if not self.attempts:
            raise AssertionError("Enter pressed more often than scripted attempts")
        step = self.attempts.pop(0)
        for response in step.get("responses", []):
            for callback in list(self.listeners):
                callback(response)
        self.current_status = step.get("status", {"found": False, "ogCardCount": 0})

    def evaluate(self, script, arg=None):
        if script.startswith("typeof prepareOGPlaceholder"):
            if self.helpers_ready:
                return self.helpers_ready.pop(0)
            return True
        if "getOGCardStatus" in script:
            return dict(self.current_status)
        if "prepareOGRetry" in script:
            self.prepare_calls.append(("retry", dict(arg)))
            return {"success": True, "fromUrl": arg["fromUrl"], "toUrl": arg["toUrl"]}
        if "prepareOGPlaceholder" in script:
            self.prepare_calls.append(("placeholder", arg))
            return {"success": True, "url": arg}
        if "cleanupOGResiduals" in script:
            if self.cleanup_og_cards is None:
                return None
            return {"ogCards": self.cleanup_og_cards}
        raise AssertionError(f"unexpected evaluate: {script[:80]}")


def scrap_response(target_url, status=500, body='{"code": 40002}', blog="anthropic.tistory.com"):
    return FakeResponse(
        f"https://{blog}/manage/scrap?url={quote(target_url, safe='')}",
        status,
        body,
    )


def found_status(count=1):
    return {"found": True, "ogCardCount": count}


def not_found_status():
    return {"found": False, "ogCardCount": 0}


class OGRetryFallbackTests(unittest.TestCase):
    def make_namespace(self, env=None):
        logs = []
        fake_time = FakeTime()

        def fail(message):
            raise PublishAbort(message)

        namespace = load_og_functions(
            {
                "time": fake_time,
                "log": logs.append,
                "fail": fail,
                "os": FakeOS(env or {}),
                "HELPER_JS": "/fake/helper.js",
            }
        )
        return namespace, fake_time, logs

    # ── strict paired-route computation (exact incident URLs) ──────────────

    def test_paired_url_for_exact_2026_08_10_and_2026_08_13_urls(self):
        ns, _, _ = self.make_namespace()
        paired = ns["dcinside_paired_og_url"]
        self.assertEqual(paired(MOBILE_URL_2026_08_10), DESKTOP_URL_2026_08_10)
        self.assertEqual(paired(MOBILE_URL_2026_08_13), DESKTOP_URL_2026_08_13)
        self.assertEqual(paired(DESKTOP_URL_2026_08_10), MOBILE_URL_2026_08_10)
        self.assertEqual(paired(DESKTOP_URL_2026_08_13), MOBILE_URL_2026_08_13)

    def test_paired_url_rejects_non_post_variants_and_other_hosts(self):
        ns, _, _ = self.make_namespace()
        paired = ns["dcinside_paired_og_url"]
        for url in [
            "https://m.dcinside.com/board/ngm",
            "https://m.dcinside.com/board/ngm/270135?page=2",
            "https://m.dcinside.com/board/ngm/270135#comment",
            "https://m.dcinside.com/mini/ngm/270135",
            "https://m.dcinside.com/board/ngm/notanumber",
            "https://m.dcinside.com/search/gall_content?keyword=x",
            "https://gall.dcinside.com/board/view/?id=ngm&no=270135&page=2",
            "https://gall.dcinside.com/board/view/?id=ngm",
            "https://gall.dcinside.com/board/lists/?id=ngm",
            "https://gall.dcinside.com/board/view/?id=ngm&no=notanumber",
            "https://gall.dcinside.com/board/view/?id=ngm&no=1&no=2",
            "https://theqoo.net/square/456",
            "https://v.daum.net/v/20260810160019001",
            "ftp://m.dcinside.com/board/ngm/270135",
            "not a url",
            "",
            None,
        ]:
            with self.subTest(url=url):
                self.assertIsNone(paired(url))

    # ── scrap response association and classification ──────────────────────

    def test_scrap_response_matches_requires_exact_url_param_on_scrap_path(self):
        ns, _, _ = self.make_namespace()
        matches = ns["scrap_response_matches"]
        scrap = scrap_response(MOBILE_URL_2026_08_13)
        self.assertTrue(matches(MOBILE_URL_2026_08_13, scrap.url))
        self.assertFalse(matches(MOBILE_URL_2026_08_10, scrap.url))
        self.assertFalse(matches(MOBILE_URL_2026_08_13, "https://anthropic.tistory.com/manage/newpost"))
        self.assertFalse(
            matches(
                MOBILE_URL_2026_08_13,
                f"https://anthropic.tistory.com/other?url={quote(MOBILE_URL_2026_08_13, safe='')}",
            )
        )
        self.assertFalse(matches("", "https://anthropic.tistory.com/manage/scrap?url="))

    def test_classify_scrap_code_parses_json_and_stays_none_when_unparsable(self):
        ns, _, _ = self.make_namespace()
        classify = ns["classify_scrap_code"]
        self.assertEqual(classify('{"code": 40002, "message": "fail"}'), "40002")
        self.assertEqual(classify('{"code": "40002"}'), "40002")
        self.assertEqual(classify('{"code": 0, "item": {}}'), "0")
        self.assertEqual(classify('code=40002'), "40002")
        self.assertIsNone(classify(""))
        self.assertIsNone(classify("<html>Internal Server Error</html>"))
        self.assertIsNone(classify('{"message": "no code field"}'))

    def test_unreadable_scrap_body_is_not_classified(self):
        ns, _, _ = self.make_namespace()
        summary = ns["summarize_scrap_responses"](
            [FakeResponse("https://x/manage/scrap?url=y", 500, RuntimeError("body gone"))]
        )
        self.assertTrue(summary["observed"])
        self.assertEqual(summary["status"], 500)
        self.assertIsNone(summary["code"])

    # ── bounded retry / fallback flow ───────────────────────────────────────

    def render(self, ns, page, url, phase="step5"):
        return ns["render_og_card_with_fallback"](page, url, 1, phase)

    def test_first_attempt_success_keeps_single_enter_and_original_latency(self):
        ns, fake_time, _ = self.make_namespace()
        page = FakePage([{"responses": [scrap_response(MOBILE_URL_2026_08_13, 200, '{"code": 0}')], "status": found_status()}])
        result = self.render(ns, page, MOBILE_URL_2026_08_13)
        self.assertEqual(result, MOBILE_URL_2026_08_13)
        self.assertEqual(page.enter_presses, 1)
        self.assertEqual(page.prepare_calls, [("placeholder", MOBILE_URL_2026_08_13)])
        # same pacing as the pre-change flow: 0.5s before Enter + one 1.5s poll
        self.assertEqual(fake_time.sleeps, [0.5, 1.5])

    def test_original_failure_then_original_retry_success(self):
        ns, fake_time, _ = self.make_namespace()
        url = "https://v.daum.net/v/20260813120000001"
        page = FakePage([
            {"responses": [], "status": not_found_status()},
            {"responses": [], "status": found_status()},
        ])
        result = self.render(ns, page, url)
        self.assertEqual(result, url)
        self.assertEqual(page.enter_presses, 2)
        self.assertEqual(
            page.prepare_calls,
            [("placeholder", url), ("retry", {"fromUrl": url, "toUrl": url})],
        )
        # bounded exponential-backoff-compatible delay between the attempts
        self.assertIn(2.0, fake_time.sleeps)

    def test_two_confirmed_40002_then_paired_desktop_fallback_success(self):
        ns, _, logs = self.make_namespace()
        page = FakePage([
            {"responses": [scrap_response(MOBILE_URL_2026_08_13)], "status": not_found_status()},
            {"responses": [scrap_response(MOBILE_URL_2026_08_13)], "status": not_found_status()},
            {"responses": [scrap_response(DESKTOP_URL_2026_08_13, 200, '{"code": 0}')], "status": found_status()},
        ])
        result = self.render(ns, page, MOBILE_URL_2026_08_13)
        self.assertEqual(result, DESKTOP_URL_2026_08_13)
        self.assertEqual(page.enter_presses, 3)
        self.assertEqual(
            page.prepare_calls[-1],
            ("retry", {"fromUrl": MOBILE_URL_2026_08_13, "toUrl": DESKTOP_URL_2026_08_13}),
        )
        self.assertTrue(any("code=40002 confirmed twice" in line for line in logs))

    def test_desktop_input_falls_back_to_mobile_pair(self):
        ns, _, _ = self.make_namespace()
        page = FakePage([
            {"responses": [scrap_response(DESKTOP_URL_2026_08_10)], "status": not_found_status()},
            {"responses": [scrap_response(DESKTOP_URL_2026_08_10)], "status": not_found_status()},
            {"responses": [], "status": found_status()},
        ])
        result = self.render(ns, page, DESKTOP_URL_2026_08_10)
        self.assertEqual(result, MOBILE_URL_2026_08_10)
        self.assertEqual(
            page.prepare_calls[-1],
            ("retry", {"fromUrl": DESKTOP_URL_2026_08_10, "toUrl": MOBILE_URL_2026_08_10}),
        )

    def test_non_dcinside_url_with_confirmed_40002_never_falls_back(self):
        ns, _, _ = self.make_namespace()
        url = "https://theqoo.net/square/456"
        page = FakePage([
            {"responses": [scrap_response(url)], "status": not_found_status()},
            {"responses": [scrap_response(url)], "status": not_found_status()},
        ])
        with self.assertRaisesRegex(PublishAbort, "OG card render failed before publish"):
            self.render(ns, page, url)
        self.assertEqual(page.enter_presses, 2)

    def test_dcinside_failure_without_confirmed_40002_never_falls_back(self):
        ns, _, _ = self.make_namespace()
        cases = {
            "non-40002 code": [scrap_response(MOBILE_URL_2026_08_13, 500, '{"code": 500}')],
            "http error, unparsable body": [scrap_response(MOBILE_URL_2026_08_13, 500, "<html>error</html>")],
            "no scrap response observed": [],
        }
        for label, responses in cases.items():
            with self.subTest(case=label):
                page = FakePage([
                    {"responses": list(responses), "status": not_found_status()},
                    {"responses": list(responses), "status": not_found_status()},
                ])
                with self.assertRaisesRegex(PublishAbort, "OG card render failed before publish"):
                    self.render(ns, page, MOBILE_URL_2026_08_13)
                self.assertEqual(page.enter_presses, 2, label)

    def test_single_40002_with_second_unknown_never_falls_back(self):
        ns, _, _ = self.make_namespace()
        page = FakePage([
            {"responses": [scrap_response(MOBILE_URL_2026_08_13)], "status": not_found_status()},
            {"responses": [], "status": not_found_status()},
        ])
        with self.assertRaisesRegex(PublishAbort, "OG card render failed before publish"):
            self.render(ns, page, MOBILE_URL_2026_08_13)
        self.assertEqual(page.enter_presses, 2)

    def test_paired_fallback_failure_aborts_with_attempt_diagnostics(self):
        ns, _, _ = self.make_namespace()
        page = FakePage([
            {"responses": [scrap_response(MOBILE_URL_2026_08_13)], "status": not_found_status()},
            {"responses": [scrap_response(MOBILE_URL_2026_08_13)], "status": not_found_status()},
            {"responses": [scrap_response(DESKTOP_URL_2026_08_13)], "status": not_found_status()},
        ])
        with self.assertRaises(PublishAbort) as ctx:
            self.render(ns, page, MOBILE_URL_2026_08_13)
        self.assertEqual(page.enter_presses, 3)
        detail = json.loads(str(ctx.exception).split("before publish: ", 1)[1])
        kinds = [attempt["kind"] for attempt in detail["attempts"]]
        self.assertEqual(kinds, ["original", "original-retry", "dcinside-paired-fallback"])
        codes = [attempt["scrapCode"] for attempt in detail["attempts"]]
        self.assertEqual(codes, ["40002", "40002", "40002"])
        for attempt in detail["attempts"]:
            self.assertNotIn("body", attempt)

    def test_recovery_phase_prefixes_failure_messages(self):
        ns, _, _ = self.make_namespace()
        page = FakePage([
            {"responses": [], "status": not_found_status()},
            {"responses": [], "status": not_found_status()},
        ])
        with self.assertRaisesRegex(PublishAbort, "recovery OG card render failed before publish"):
            self.render(ns, page, MOBILE_URL_2026_08_13, phase="recovery")

    def test_render_og_cards_enforces_cleanup_count_gate(self):
        ns, _, _ = self.make_namespace()
        page = FakePage(
            [{"responses": [], "status": found_status()}],
            cleanup_og_cards=0,
        )
        with self.assertRaisesRegex(PublishAbort, "OG card count mismatch before publish: expected 1, got 0"):
            ns["render_og_cards"](page, [MOBILE_URL_2026_08_13], "step5")

    def test_render_og_cards_reinjects_missing_helpers(self):
        ns, _, _ = self.make_namespace()
        page = FakePage(
            [{"responses": [], "status": found_status()}],
            helpers_ready=[False, True],
            cleanup_og_cards=1,
        )
        ns["render_og_cards"](page, [MOBILE_URL_2026_08_13], "recovery")
        self.assertEqual(page.injected_helpers, ["/fake/helper.js"])

    def test_render_og_cards_skips_when_no_urls(self):
        ns, _, _ = self.make_namespace()
        page = FakePage([])
        ns["render_og_cards"](page, [], "step5")
        self.assertEqual(page.enter_presses, 0)

    def test_listener_removed(self):
        ns, _, _ = self.make_namespace()
        page = FakePage([
            {"responses": [scrap_response(MOBILE_URL_2026_08_13)], "status": found_status()},
        ])
        self.render(ns, page, MOBILE_URL_2026_08_13)
        self.assertEqual(page.listeners, [])

    # ── flow-sharing gate: Step 5 and recovery must use the same helper ─────

    def test_step5_and_recovery_use_the_same_render_helper(self):
        source = SCRIPT_PATH.read_text(encoding="utf-8")
        self.assertIn("render_og_cards(page, og_urls, 'step5')", source)
        self.assertIn("render_og_cards(page, og_urls, 'recovery')", source)
        embedded = re.search(r"<< 'PYTHON_SCRIPT'\n(.*?)\nPYTHON_SCRIPT\n", source, re.DOTALL).group(1)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", SyntaxWarning)
            tree = ast.parse(embedded)
        # No inline Enter-press OG loops outside the shared helper: every
        # page.keyboard.press must live in a known function, none in the
        # module-level Step 5 / recovery flow.
        def is_keyboard_press(node):
            return (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "press"
                and isinstance(node.func.value, ast.Attribute)
                and node.func.value.attr == "keyboard"
            )

        functions_with_press = set()
        for func in ast.walk(tree):
            if isinstance(func, ast.FunctionDef):
                for node in ast.walk(func):
                    if is_keyboard_press(node):
                        functions_with_press.add(func.name)
        module_level_presses = [
            node
            for node in ast.walk(tree)
            if is_keyboard_press(node)
        ]
        in_functions = sum(
            1
            for func in ast.walk(tree)
            if isinstance(func, ast.FunctionDef)
            for node in ast.walk(func)
            if is_keyboard_press(node)
        )
        self.assertEqual(
            len(module_level_presses), in_functions,
            "page.keyboard.press must not appear inline in the module-level flow",
        )
        self.assertIn("attempt_og_render", functions_with_press)
        self.assertLessEqual(
            functions_with_press, {"attempt_og_render", "enter_tag"},
            "OG Enter presses must stay inside attempt_og_render",
        )


class FakeOS:
    """Minimal os stand-in exposing environ for og_backoff_delay_s."""

    def __init__(self, env):
        self.environ = dict(env)


class BackoffTests(unittest.TestCase):
    def test_backoff_is_bounded_and_exponential_compatible(self):
        logs = []
        fake_time = FakeTime()
        ns = load_og_functions(
            {
                "time": fake_time,
                "log": logs.append,
                "fail": lambda m: (_ for _ in ()).throw(PublishAbort(m)),
                "os": FakeOS({}),
                "HELPER_JS": "/fake/helper.js",
            }
        )
        delay = ns["og_backoff_delay_s"]
        self.assertEqual(delay(1), 2.0)
        self.assertEqual(delay(2), 4.0)
        self.assertEqual(delay(3), 8.0)
        self.assertEqual(delay(10), 8.0)  # capped

    def test_backoff_env_overrides(self):
        ns = load_og_functions(
            {
                "time": FakeTime(),
                "log": lambda m: None,
                "fail": lambda m: (_ for _ in ()).throw(PublishAbort(m)),
                "os": FakeOS({"TISTORY_OG_RETRY_BACKOFF_BASE_S": "1", "TISTORY_OG_RETRY_BACKOFF_MAX_S": "3"}),
                "HELPER_JS": "/fake/helper.js",
            }
        )
        delay = ns["og_backoff_delay_s"]
        self.assertEqual(delay(1), 1.0)
        self.assertEqual(delay(2), 2.0)
        self.assertEqual(delay(3), 3.0)


if __name__ == "__main__":
    unittest.main()
