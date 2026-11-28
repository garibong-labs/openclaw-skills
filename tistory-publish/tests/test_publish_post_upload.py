import ast
import json
import os
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
    "arm_daum_inline_delivery",
    "observe_daum_inline_dialog",
    "confirm_daum_inline_upload",
    "upload_daum_inline_slot",
    "upload_daum_inline_images",
    "handle_dialog",
}


def load_upload_functions(overrides, include_step=False):
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
    if include_step:
        with_browser = next(node for node in tree.body if isinstance(node, ast.With)
                            and any(isinstance(item, ast.Assign) and ast.unparse(item.targets[0]) == 'image_files'
                                    for item in node.body))
        start = next(index for index, node in enumerate(with_browser.body) if isinstance(node, ast.Assign)
                     and ast.unparse(node.targets[0]) == 'image_files')
        step = with_browser.body[start:start + 4]
        after_step = ast.parse('downstream.append("og")\ndownstream.append("submit")').body
        namespace['step'] = compile(ast.Module(body=step + after_step, type_ignores=[]), str(SCRIPT_PATH), 'exec')
    return namespace


class FakeTime:
    def __init__(self):
        self.sleeps = []

    def sleep(self, seconds):
        self.sleeps.append(seconds)

    def monotonic(self):
        return sum(self.sleeps)


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

    def set_input_files(self, image_path, **options):
        self.page.assign(self.selector, image_path, options)


class FakeFileChooser:
    def __init__(self, page):
        self.page = page

    def set_files(self, image_path, **options):
        self.page.assign("file-chooser", image_path, options)


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

    def assign(self, selector, image_path, _options):
        if self.set_input_failures > 0:
            self.set_input_failures -= 1
            raise RuntimeError("input detached during upload")
        self.uploads.append((selector, image_path))

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

    def test_mk_single_delivery_keeps_its_existing_failure(self):
        upload, fake_time, _logs, artifacts = self.make_helpers()
        page = FakePage(file_chooser_ready_attempt=1, preferred_ready_attempt=1, set_input_failures=1)
        with self.assertRaisesRegex(RuntimeError, 'MK upload delivery uncertain'):
            upload(page, '/synthetic/mk.jpg', 'MK article', single_delivery=True)
        self.assertEqual(page.menu_attempts, 1)
        self.assertEqual(page.uploads, [])
        self.assertEqual(fake_time.sleeps, [])
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


UPLOAD_ALERT = '업로드가 실패했습니다. 네트워크 상태를 확인해 주세요.'


class FakeDialog:
    def __init__(self, message, kind='alert'):
        self.type, self.message = kind, message
        self.accepted = False

    def accept(self):
        self.accepted = True


class FakeDaumPage(FakePage):
    def __init__(self, fake_time, scenarios, **options):
        super().__init__(**{'file_chooser_ready_attempt': 1, **options})
        self.fake_time = fake_time
        self.scenarios = scenarios
        self.timeline = []
        self.assignment_attempts = []
        self.figures = 0
        self.guard_count = None
        self.before_delivery = None
        self.assignment_dialog = None

    def emit_dialog(self, message):
        dialog = FakeDialog(message)
        self.on_dialog(dialog)
        assert dialog.accepted

    def open_menu(self):
        self.menu_attempts += 1
        if self.before_delivery:
            self.emit_dialog(self.before_delivery)

    def assign(self, selector, image_path, options):
        assert options == {'timeout': 5000}
        assert self.item['filename'] == os.path.basename(image_path)
        self.assignment_attempts.append(selector)
        super().assign(selector, image_path, options)
        self.timeline.append(('delivery', self.item['marker']))
        if self.assignment_dialog is not None:
            self.emit_dialog(self.assignment_dialog)
            raise RuntimeError('synthetic assignment error after dialog')

    def wait_for_timeout(self, milliseconds):
        self.fake_time.sleep(milliseconds / 1000)

    def evaluate(self, script, arg=None):
        if script == '(item) => beginDaumInlineUpload(item)':
            self.item = arg
            self.polls = 0
            return True
        if script == '() => pollDaumInlineUpload()':
            states, dialogs = self.scenarios[len(self.uploads) - 1]
            if self.polls == 0:
                for message in dialogs:
                    self.emit_dialog(message)
            self.polls += 1
            return states[min(self.polls, len(states)) - 1]
        if script == '() => finishDaumInlineUpload()':
            self.figures += 1
            self.timeline.append(('bind', self.item['marker']))
            return True
        if script == '() => abortDaumInlineUpload()':
            self.timeline.append(('abort', self.item['marker']))
            return None
        if script == '(caption) => countDaumInlineFigures(caption)':
            return {'figures': self.figures if self.guard_count is None else self.guard_count,
                    'matchingCaptions': self.figures}
        raise AssertionError(script)


class DaumInlineStepTests(unittest.TestCase):
    healthy = (['pending', 'candidate', 'candidate', 'ready'], [])

    def set_up_step(self, scenarios, **options):
        fake_time = FakeTime()
        page = FakeDaumPage(fake_time, scenarios, **options)
        files = [f'/synthetic/{index:02d}-fixture.jpg' for index in range(4)]
        logs = []

        def fail(code):
            raise SystemExit(code)

        namespace = load_upload_functions({
            'page': page, 'time': fake_time, 'log': logs.append, 'os': type('FakeOS', (), {
                'environ': {'TISTORY_INLINE_IMAGE_FILES': ':'.join(files),
                            'TISTORY_INLINE_IMAGE_CAPTION': '합성 캡션'}, 'path': os.path,
            }), 'TEMPLATE': 'daum-trends', 'mk_images': type('NoMK', (), {'enabled': False}),
            'open_attach_image_menu': lambda page: page.open_menu(), 'fail': fail,
            'downstream': [], 'last_dialog_message': None, 'daum_inline_delivery': None,
        }, include_step=True)
        page.on_dialog = namespace['handle_dialog']
        return page, namespace, logs

    def assert_stopped(self, page, namespace, code, deliveries, figures):
        with self.assertRaises(SystemExit) as error:
            exec(namespace['step'], namespace)
        self.assertEqual(str(error.exception), code)
        self.assertEqual(len(page.uploads), deliveries)
        self.assertEqual(page.figures, figures)
        self.assertEqual(namespace['downstream'], [])
        self.assertIsNone(namespace['daum_inline_delivery'])

    def test_four_slots_wait_for_binding_before_next_delivery(self):
        page, namespace, logs = self.set_up_step([self.healthy] * 4)
        # Earlier dialogs in the generic publisher state are stale.
        namespace['last_dialog_message'] = {'type': 'alert', 'message': UPLOAD_ALERT}
        exec(namespace['step'], namespace)
        self.assertEqual(page.timeline, [(action, f'trend-image-{slot}')
                                        for slot in range(1, 5) for action in ('delivery', 'bind')])
        self.assertEqual(page.fake_time.sleeps, [0.25] * 12)
        self.assertEqual(namespace['downstream'], ['og', 'submit'])
        self.assertEqual(logs, ['Step 3.5: 완료'])

    def test_fourth_slot_editor_alert_stops_with_three_figures(self):
        page, namespace, logs = self.set_up_step([self.healthy] * 3 + [(['pending'], [UPLOAD_ALERT])])
        self.assert_stopped(page, namespace, 'daum-inline/editor-reported-failure slot=4', 4, 3)
        self.assertEqual(page.menu_attempts, 4)
        self.assertEqual(logs, [])

    def test_no_signal_times_out_and_never_delivers_later_slots(self):
        page, namespace, _ = self.set_up_step([self.healthy, (['pending'], [])])
        self.assert_stopped(page, namespace, 'daum-inline/completion-uncertain slot=2', 2, 1)
        self.assertEqual(page.fake_time.monotonic(), 30.75)
        self.assertEqual(page.menu_attempts, 2)

    def test_unrelated_repeated_and_contradictory_dialogs_stay_uncertain(self):
        for states, dialogs in [(['pending'], [UPLOAD_ALERT + ' ']),
                                (['pending'], ['unrelated synthetic dialog']),
                                (['pending'], [UPLOAD_ALERT, UPLOAD_ALERT]),
                                (['candidate'], [UPLOAD_ALERT]), (['uncertain'], [])]:
            with self.subTest(states=states, dialogs=dialogs):
                page, namespace, logs = self.set_up_step([(states, dialogs)])
                self.assert_stopped(page, namespace, 'daum-inline/completion-uncertain slot=1', 1, 0)
                self.assertEqual(page.menu_attempts, 1)
                self.assertEqual(logs, [])

    def test_pre_delivery_alert_is_never_confirmed_or_delivered(self):
        page, namespace, logs = self.set_up_step([])
        page.before_delivery = UPLOAD_ALERT
        self.assert_stopped(page, namespace, 'daum-inline/assignment-uncertain slot=1', 0, 0)
        self.assertEqual(page.assignment_attempts, [])
        self.assertEqual(logs, [])

    def test_assignment_exception_does_not_retry_chooser_or_dom(self):
        for chooser_ready in [1, 99]:
            with self.subTest(chooser_ready=chooser_ready):
                page, namespace, logs = self.set_up_step([], file_chooser_ready_attempt=chooser_ready,
                                                        preferred_ready_attempt=1, set_input_failures=1)
                self.assert_stopped(page, namespace, 'daum-inline/assignment-uncertain slot=1', 0, 0)
                self.assertEqual(len(page.assignment_attempts), 1)
                self.assertEqual(page.menu_attempts, 1)
                self.assertEqual(page.polls, 0)
                self.assertEqual(logs, [])

    def test_assignment_alert_followed_by_exception_requires_consistent_evidence(self):
        for states, alert, code, polls in [
            (['pending'], UPLOAD_ALERT, 'editor-reported-failure', 3),
            (['ready'], UPLOAD_ALERT, 'completion-uncertain', 1),
            (['pending'], UPLOAD_ALERT + ' ', 'assignment-uncertain', 0),
        ]:
            with self.subTest(states=states, code=code):
                page, namespace, logs = self.set_up_step([(states, [])])
                page.assignment_dialog = alert
                self.assert_stopped(page, namespace, f'daum-inline/{code} slot=1', 1, 0)
                self.assertEqual(page.assignment_attempts, ['file-chooser'])
                self.assertEqual(page.menu_attempts, 1)
                self.assertEqual(page.polls, polls)
                self.assertEqual(logs, [])

    def test_empty_colon_delimited_list_stops_before_delivery(self):
        page, namespace, logs = self.set_up_step([])
        namespace['os'].environ['TISTORY_INLINE_IMAGE_FILES'] = ' ::: '
        self.assert_stopped(page, namespace, 'daum-inline/empty-file-list slot=1', 0, 0)
        self.assertEqual(page.menu_attempts, 0)
        self.assertEqual(page.timeline, [])
        self.assertEqual(logs, [])

    def test_pre_delivery_retry_and_final_figure_count_guard(self):
        page, namespace, _ = self.set_up_step([self.healthy] * 4, file_chooser_ready_attempt=2)
        page.guard_count = 3
        self.assert_stopped(page, namespace, 'daum-inline/figure-count-mismatch slot=4', 4, 4)
        self.assertEqual(page.menu_attempts, 5)
        self.assertEqual(page.fake_time.sleeps[0], 2)


if __name__ == "__main__":
    unittest.main()
