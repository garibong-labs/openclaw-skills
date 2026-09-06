import ast
import re
import unittest
import warnings
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "publish-post.sh"
FUNCTION_NAMES = {
    "log_best_effort",
    "capture_page_target_id",
    "close_daum_trends_run_target",
}


def load_cleanup_helpers():
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
        raise AssertionError("Daum Trends tab cleanup helpers not found in embedded Python")

    logs = []
    closes = []

    def close_target(target_id, timeout=5):
        closes.append((target_id, timeout))

    namespace = {
        "log": logs.append,
        "cdp_close_target": close_target,
    }
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(SCRIPT_PATH), "exec"), namespace)
    namespace["logs"] = logs
    namespace["closes"] = closes
    return namespace


class FakeSession:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.commands = []
        self.detached = False

    def send(self, command):
        self.commands.append(command)
        if self.error:
            raise self.error
        return self.response

    def detach(self):
        self.detached = True


class FakeContext:
    def __init__(self, session):
        self.session = session
        self.pages = []

    def new_cdp_session(self, page):
        self.pages.append(page)
        return self.session


class FakePage:
    def __init__(self, session):
        self.context = FakeContext(session)


class DaumTrendsTabCleanupTests(unittest.TestCase):
    def setUp(self):
        self.ns = load_cleanup_helpers()
        self.capture = self.ns["capture_page_target_id"]
        self.close = self.ns["close_daum_trends_run_target"]

    def test_captures_only_the_newly_created_page_target(self):
        session = FakeSession({"targetInfo": {"targetId": "run-page-123"}})
        page = FakePage(session)

        self.assertEqual(self.capture(page), "run-page-123")
        self.assertEqual(session.commands, ["Target.getTargetInfo"])
        self.assertTrue(session.detached)
        self.assertEqual(page.context.pages, [page])

    def test_unidentified_created_page_is_left_open(self):
        session = FakeSession({"targetInfo": {}})

        self.assertIsNone(self.capture(FakePage(session)))
        self.assertTrue(session.detached)
        self.assertEqual(self.ns["closes"], [])
        self.assertTrue(any("target id unavailable" in message for message in self.ns["logs"]))

    def test_target_capture_failure_is_nonfatal(self):
        session = FakeSession(error=RuntimeError("CDP unavailable"))

        self.assertIsNone(self.capture(FakePage(session)))
        self.assertTrue(session.detached)

    def test_operator_interrupt_during_target_capture_is_not_swallowed(self):
        session = FakeSession(error=KeyboardInterrupt("operator stop"))

        with self.assertRaises(KeyboardInterrupt):
            self.capture(FakePage(session))
        self.assertTrue(session.detached)

    def test_close_is_limited_to_daum_trends_and_exact_target(self):
        self.assertTrue(self.close("daum-trends", "run-page-123"))
        self.assertEqual(self.ns["closes"], [("run-page-123", 5)])
        self.assertFalse(self.close("simple-post", "run-page-456"))
        self.assertFalse(self.close("daum-trends", None))
        self.assertEqual(self.ns["closes"], [("run-page-123", 5)])

    def test_cleanup_failures_cannot_replace_success(self):
        def failing_close(target_id, timeout=5):
            raise KeyboardInterrupt("operator interruption after verified publish")

        def failing_log(message):
            raise BrokenPipeError("stderr unavailable")

        self.ns["cdp_close_target"] = failing_close
        self.ns["log"] = failing_log

        self.assertFalse(self.close("daum-trends", "run-page-123"))

    def test_source_has_no_url_heuristic_or_failure_path_cleanup(self):
        source = SCRIPT_PATH.read_text(encoding="utf-8")
        self.assertNotIn("DaumTrendsTabCleanup", source)
        self.assertNotIn("cleanup_daum_trends_management_pages", source)
        self.assertNotIn("daum_trends_management_page_kind", source)
        self.assertNotIn("select_daum_trends_management_pages_to_close", source)
        self.assertNotIn("Preflight: Daum Trends management tab cleanup", source)
        self.assertEqual(source.count("close_daum_trends_run_target(TEMPLATE, run_page_target_id)"), 1)
        self.assertIsNotNone(re.search(
            r"if HARD_FAIL:.*?fail\(HARD_FAIL\).*?print\(json\.dumps\(result\)\).*?close_daum_trends_run_target\(TEMPLATE, run_page_target_id\)",
            source,
            re.DOTALL,
        ))


if __name__ == "__main__":
    unittest.main()
