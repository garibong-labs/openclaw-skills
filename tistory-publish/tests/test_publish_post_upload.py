import ast
import json
import re
import shutil
import subprocess
import unittest
import warnings
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "publish-post.sh"
FUNCTION_NAMES = {
    "get_image_upload_dom_state",
    "find_image_file_input",
    "upload_editor_image",
}


def load_upload_functions(overrides):
    shell_source = SCRIPT_PATH.read_text(encoding="utf-8")
    match = re.search(r"<< 'PYTHON_SCRIPT'\n(.*?)\nPYTHON_SCRIPT\n", shell_source, re.DOTALL)
    if not match:
        raise AssertionError("embedded Python publish script not found")

    # The embedded legacy script contains two unrelated invalid-escape warnings.
    # Keep this focused test quiet while still compiling the selected helpers.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", SyntaxWarning)
        tree = ast.parse(match.group(1), filename=str(SCRIPT_PATH))
    selected = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name in FUNCTION_NAMES
    ]
    if {node.name for node in selected} != FUNCTION_NAMES:
        raise AssertionError("upload helper functions not found in embedded Python")

    namespace = {"re": re, **overrides}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(SCRIPT_PATH), "exec"), namespace)
    return namespace


class FakeTime:
    def __init__(self):
        self.sleeps = []

    def sleep(self, seconds):
        self.sleeps.append(seconds)


class FakeLocator:
    def __init__(self, page, selector):
        self.page = page
        self.selector = selector

    @property
    def first(self):
        return self

    def count(self):
        if self.selector == 'input[type="file"]':
            return self.page.generic_input_count
        return int(self.page.menu_attempts >= self.page.preferred_ready_attempt)

    def wait_for(self, state, timeout):
        if state != "attached":
            raise AssertionError(f"unexpected state: {state}")
        if self.selector.startswith("#openFile"):
            if self.page.menu_attempts < self.page.preferred_ready_attempt:
                raise TimeoutError("preferred input not attached")
            return
        if self.selector == 'input[type="file"]' and self.page.generic_input_count == 1:
            return
        raise TimeoutError("file input not attached")

    def set_input_files(self, image_path):
        if self.page.set_input_failures > 0:
            self.page.set_input_failures -= 1
            raise RuntimeError("input detached during upload")
        self.page.uploads.append((self.selector, image_path))


class FakeFileChooser:
    def __init__(self, page):
        self.page = page

    def set_files(self, image_path):
        if self.page.set_input_failures > 0:
            self.page.set_input_failures -= 1
            raise RuntimeError("file chooser detached during upload")
        self.page.uploads.append(("file-chooser", image_path))


class FakeFileChooserExpectation:
    def __init__(self, page):
        self.page = page
        self.value = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, _exc, _tb):
        if exc_type is not None:
            return False
        if self.page.menu_attempts < self.page.file_chooser_ready_attempt:
            raise TimeoutError("file chooser event not emitted")
        self.value = FakeFileChooser(self.page)
        return False


class FakePage:
    def __init__(
        self,
        preferred_ready_attempt=99,
        generic_input_count=0,
        set_input_failures=0,
        file_chooser_ready_attempt=99,
    ):
        self.preferred_ready_attempt = preferred_ready_attempt
        self.generic_input_count = generic_input_count
        self.set_input_failures = set_input_failures
        self.file_chooser_ready_attempt = file_chooser_ready_attempt
        self.menu_attempts = 0
        self.uploads = []

    def locator(self, selector):
        return FakeLocator(self, selector)

    def expect_file_chooser(self, timeout):
        if timeout != 5000:
            raise AssertionError(f"unexpected file chooser timeout: {timeout}")
        return FakeFileChooserExpectation(self)

    def evaluate(self, _script):
        return {
            "fileInputs": [
                {"index": index, "id": "", "accept": "", "connected": True}
                for index in range(self.generic_input_count)
            ],
            "attachButtons": [{"index": 0, "visible": True, "disabled": False}],
            "photoMenuItems": [],
        }


class PublishPostUploadTests(unittest.TestCase):
    def make_helpers(self):
        logs = []
        artifacts = []
        fake_time = FakeTime()

        def open_menu(page):
            page.menu_attempts += 1

        namespace = load_upload_functions(
            {
                "time": fake_time,
                "log": logs.append,
                "open_attach_image_menu": open_menu,
                "write_debug_artifacts": lambda _page, prefix: artifacts.append(prefix),
            }
        )
        return namespace["upload_editor_image"], fake_time, logs, artifacts

    def test_captures_file_chooser_before_transient_input_is_removed(self):
        upload, fake_time, logs, artifacts = self.make_helpers()
        page = FakePage(file_chooser_ready_attempt=1)

        upload(page, "/tmp/inline.jpg", "inline image 1/4")

        self.assertEqual(page.menu_attempts, 1)
        self.assertEqual(page.uploads, [("file-chooser", "/tmp/inline.jpg")])
        self.assertEqual(fake_time.sleeps, [])
        self.assertEqual(artifacts, [])
        self.assertTrue(any("selector=file-chooser" in line for line in logs))

    def test_retries_when_file_chooser_assignment_fails(self):
        upload, fake_time, _logs, artifacts = self.make_helpers()
        page = FakePage(file_chooser_ready_attempt=1, set_input_failures=1)

        upload(page, "/tmp/inline.jpg", "inline image 1/4")

        self.assertEqual(page.menu_attempts, 2)
        self.assertEqual(page.uploads, [("file-chooser", "/tmp/inline.jpg")])
        self.assertEqual(fake_time.sleeps, [2])
        self.assertEqual(artifacts, [])

    def test_reopens_menu_until_preferred_input_is_attached(self):
        upload, fake_time, logs, artifacts = self.make_helpers()
        page = FakePage(preferred_ready_attempt=2)

        upload(page, "/tmp/inline.jpg", "inline image 1/4")

        self.assertEqual(page.menu_attempts, 2)
        self.assertEqual(page.uploads, [('#openFile, input[type="file"][accept*="image" i]', "/tmp/inline.jpg")])
        self.assertEqual(fake_time.sleeps, [2])
        self.assertEqual(artifacts, [])
        self.assertTrue(any("attempt 2/3" in line for line in logs))

    def test_uses_single_generic_file_input_fallback(self):
        upload, fake_time, logs, artifacts = self.make_helpers()
        page = FakePage(generic_input_count=1)

        upload(page, "/tmp/banner.jpg", "banner")

        self.assertEqual(page.menu_attempts, 1)
        self.assertEqual(page.uploads, [('input[type="file"]', "/tmp/banner.jpg")])
        self.assertEqual(fake_time.sleeps, [])
        self.assertEqual(artifacts, [])
        self.assertTrue(any("selector=single-file-input" in line for line in logs))

    def test_retries_when_input_detaches_during_file_assignment(self):
        upload, fake_time, _logs, artifacts = self.make_helpers()
        page = FakePage(preferred_ready_attempt=1, set_input_failures=1)

        upload(page, "/tmp/inline.jpg", "inline image 1/4")

        self.assertEqual(page.menu_attempts, 2)
        self.assertEqual(page.uploads, [('#openFile, input[type="file"][accept*="image" i]', "/tmp/inline.jpg")])
        self.assertEqual(fake_time.sleeps, [2])
        self.assertEqual(artifacts, [])

    def test_writes_debug_artifacts_after_bounded_retries(self):
        upload, fake_time, logs, artifacts = self.make_helpers()
        page = FakePage()

        with self.assertRaisesRegex(RuntimeError, "after 3 attempts"):
            upload(page, "/tmp/inline.jpg", "inline image 1/4")

        self.assertEqual(page.menu_attempts, 3)
        self.assertEqual(page.uploads, [])
        self.assertEqual(fake_time.sleeps, [2, 4])
        self.assertEqual(artifacts, ["inline-image-1-4-upload-input-failed"])
        self.assertEqual(sum("upload input unavailable" in line for line in logs), 3)

    def test_dom_state_javascript_is_syntactically_valid(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is unavailable")
        shell_source = SCRIPT_PATH.read_text(encoding="utf-8")
        match = re.search(
            r"def get_image_upload_dom_state\(page\):.*?page\.evaluate\(\"\"\"(.*?)\"\"\"\)",
            shell_source,
            re.DOTALL,
        )
        self.assertIsNotNone(match, "DOM-state JavaScript not found")
        javascript = match.group(1)
        program = f"new Function('return (' + {json.dumps(javascript)} + ')');"
        result = subprocess.run(
            [node, "-e", program],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
