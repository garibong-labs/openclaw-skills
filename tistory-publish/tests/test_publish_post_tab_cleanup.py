import ast
import importlib.util
import json
import re
import subprocess
import unittest
import warnings
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit


SCRIPT_PATH = Path(__file__).resolve().parents[1] / 'scripts' / 'publish-post.sh'
SPEC = importlib.util.spec_from_file_location(
    'owned_cleanup', SCRIPT_PATH.with_name('cdp_owned_tab_cleanup.py'))
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)
FUNCTION_NAMES = {'log_best_effort', 'capture_page_target_id', 'close_verified_run_target'}


def embedded_tree():
    match = re.search(r"<< 'PYTHON_SCRIPT'\n(.*?)\nPYTHON_SCRIPT\n",
                      SCRIPT_PATH.read_text(), re.DOTALL)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', SyntaxWarning)
        return ast.parse(match.group(1))


def load_cleanup_helpers():
    selected = [node for node in embedded_tree().body
                if isinstance(node, ast.FunctionDef) and node.name in FUNCTION_NAMES]
    assert {node.name for node in selected} == FUNCTION_NAMES
    logs, closes = [], []

    def cleanup(port, target_id):
        closes.append((port, target_id))
        return 'closed'

    ns = {'log': logs.append, 'cleanup_owned_target': cleanup, 'CDP_PORT': '9222'}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(SCRIPT_PATH), 'exec'), ns)
    ns.update(logs=logs, closes=closes)
    return ns


class FakeSession:
    def __init__(self, response=None, error=None):
        self.response, self.error = response, error
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
        self.requests = []
        self.pages = [object(), object()]  # Existing user tabs; never selected or closed.

    def new_cdp_session(self, page):
        self.requests.append(page)
        return self.session


class FakePage:
    def __init__(self, session):
        self.context = FakeContext(session)


class RunTabCleanupTests(unittest.TestCase):
    def setUp(self):
        self.ns = load_cleanup_helpers()
        self.capture = self.ns['capture_page_target_id']
        self.close = self.ns['close_verified_run_target']
        self.success = {'success': True, 'postUrl': 'https://example.test/123', 'postId': '123'}

    def test_capture_only_exact_new_page_preserves_user_tabs(self):
        session = FakeSession({'targetInfo': {'targetId': 'run', 'type': 'page'}})
        page = FakePage(session)
        before = list(page.context.pages)
        self.assertEqual(self.capture(page), 'run')
        self.assertEqual(session.commands, ['Target.getTargetInfo'])
        self.assertEqual(page.context.requests, [page])
        self.assertEqual(page.context.pages, before)
        self.assertTrue(session.detached)

    def test_missing_or_mismatched_identity_leaves_page_open(self):
        for info in ({}, {'targetId': 'run'}, {'targetId': 'run', 'type': 'worker'}):
            session = FakeSession({'targetInfo': info})
            self.assertIsNone(self.capture(FakePage(session)))
            self.assertTrue(session.detached)
        self.assertEqual(self.ns['closes'], [])

    def test_capture_exception_nonfatal_but_operator_interrupt_propagates(self):
        session = FakeSession(error=RuntimeError('unavailable'))
        self.assertIsNone(self.capture(FakePage(session)))
        self.assertTrue(session.detached)
        session = FakeSession(error=KeyboardInterrupt())
        with self.assertRaises(KeyboardInterrupt):
            self.capture(FakePage(session))
        self.assertTrue(session.detached)

    def test_mk_and_daum_verified_success_close_only_captured_target(self):
        for template in ('mk-review', 'daum-trends'):
            self.assertTrue(self.close(template, 'run', self.success))
        self.assertEqual(self.ns['closes'], [('9222', 'run')] * 2)

    def test_failure_uncertain_missing_identity_and_other_templates_do_not_close(self):
        cases = [
            ('mk-review', 'run', {'success': False}),
            ('daum-trends', 'run', {'success': False}),
            ('mk-review', None, self.success),
            ('daum-trends', None, self.success),
            ('mk-review', 'run', {'success': True}),
            ('mk-review', 'run', dict(self.success, postId=None)),
            ('mk-review', 'run', dict(self.success, postUrl=None)),
            ('mk-review', 'run', dict(self.success, warning='post_publish_resave_failed')),
            ('simple-post', 'run', self.success),
            ('', 'run', self.success),
        ]
        for args in cases:
            self.assertFalse(self.close(*args), args)
        self.assertFalse(self.close('mk-review', 'run', self.success, True))
        self.assertEqual(self.ns['closes'], [])

    def test_daum_existing_warning_and_success_eligibility_preserved(self):
        self.assertTrue(self.close('daum-trends', 'run', {'success': True, 'warning': 'existing'}, True))

    def test_cleanup_failure_never_changes_success_or_claims_closure(self):
        original = dict(self.success)
        for status in ('timeout', 'unconfirmed', 'target_missing', 'identity_mismatch'):
            self.ns['cleanup_owned_target'] = lambda *args: status
            self.assertFalse(self.close('mk-review', 'run', self.success))
        self.assertEqual(self.success, original)
        self.assertFalse(any('confirmed this run' in log for log in self.ns['logs']))

        def interrupt(*args):
            raise KeyboardInterrupt()

        self.ns['cleanup_owned_target'] = interrupt
        self.ns['log'] = interrupt
        self.assertFalse(self.close('mk-review', 'run', self.success))
        self.assertEqual(self.success, original)

    def test_actual_result_tail_failure_gates_cleanup_and_success_keeps_result(self):
        # Execute the real result/cleanup tail, not a mirrored implementation.
        block = next(node for node in embedded_tree().body if isinstance(node, ast.With))
        start = next(i for i, node in enumerate(block.body)
                     if isinstance(node, ast.Assign) and any(
                         isinstance(t, ast.Name) and t.id == 'result' for t in node.targets))
        end = next(i for i, node in enumerate(block.body)
                   if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
                   and isinstance(node.value.func, ast.Name)
                   and node.value.func.id == 'close_verified_run_target')
        code = compile(ast.Module(body=block.body[start:end + 1], type_ignores=[]), str(SCRIPT_PATH), 'exec')

        def fail(message):
            raise SystemExit(message)

        for template in ('mk-review', 'daum-trends'):
            for hard_fail, warning, uncertain in ((None, None, False), ('public_body_empty', None, False),
                                                   ('public_verification_failed', None, False),
                                                   (None, 'post_publish_edit_tinymce_timeout', False),
                                                   (None, None, True)):
                self.ns.update(TEMPLATE=template, run_page_target_id='run', json=json,
                               final_url='manage/posts', elapsed=123, PRIVATE=False,
                               post_info={'id': '123', 'url': 'https://example.test/123'},
                               PUBLIC_BASE_URL='', gap_check=None, og_render_summary=None,
                               draft_og_gate=None, public_og_gate=None, warning=warning,
                               HARD_FAIL=hard_fail, post_publish_uncertain=uncertain,
                               fail=fail, sys=__import__('sys'))
                self.ns['closes'].clear()
                with patch('builtins.print'):
                    if hard_fail:
                        with self.assertRaises(SystemExit):
                            exec(code, self.ns)
                    else:
                        exec(code, self.ns)
                expected = not hard_fail and (template == 'daum-trends' or not (warning or uncertain))
                self.assertEqual(bool(self.ns['closes']), expected)
                self.assertEqual(self.ns['result']['success'], not bool(hard_fail))

    def test_real_post_publish_branches_preserve_uncertain_mk_run(self):
        block = next(node for node in embedded_tree().body if isinstance(node, ast.With))
        step10 = next(node for node in block.body if isinstance(node, ast.If)
                      and isinstance(node.test, ast.BoolOp)
                      and [getattr(value, 'id', None) for value in node.test.values] == ['post_info', 'og_entries'])
        code = compile(ast.Module(body=[step10], type_ignores=[]), str(SCRIPT_PATH), 'exec')
        for ready, saved, gap, should_close in (
            (True, True, {'gapPersists': False}, True),
            (False, True, {'gapPersists': False}, False),
            (True, False, {'gapPersists': False}, False),
            (True, RuntimeError('resave race'), {'gapPersists': False}, False),
            (True, True, {'gapPersists': True}, False),
            (True, True, None, False),
            (True, True, {}, False),
        ):
            def resave(*args, **kwargs):
                if 'save_confirmation' in kwargs:
                    kwargs['save_confirmation']['confirmed'] = saved is True
                if isinstance(saved, Exception):
                    raise saved
                return saved

            page = SimpleNamespace(goto=lambda *a, **k: None,
                                   add_script_tag=lambda **k: None,
                                   evaluate=lambda *a: {})
            self.ns.update(page=page, post_info={'id': '123', 'url': 'https://example.test/123'},
                           og_entries=['placeholder'], BLOG='example.test', HELPER_JS='helper.js',
                           TEMPLATE='mk-review', PRIVATE=False, wait_tinymce=lambda *a, **k: ready,
                           republish_current_editor=resave, inspect_gap=lambda *a: gap,
                           time=SimpleNamespace(sleep=lambda *a: None), warning=None,
                           post_publish_uncertain=False)
            self.ns['closes'].clear()
            exec(code, self.ns)
            result = dict(self.success)
            if self.ns['warning']:
                result['warning'] = self.ns['warning']
            self.assertEqual(self.close('mk-review', 'run', result,
                                        self.ns['post_publish_uncertain']), should_close)

    def test_cleanup_call_only_after_verification_no_failure_finally(self):
        source = SCRIPT_PATH.read_text()
        call = 'close_verified_run_target(TEMPLATE, run_page_target_id, result, post_publish_uncertain)'
        self.assertEqual(source.count(call), 1)
        self.assertLess(source.index('# ── Step 11:'), source.index(call))
        self.assertLess(source.index('fail(HARD_FAIL)'), source.index(call))
        # No additional browser/context closure introduced by the cleanup helper.
        helper = next(node for node in embedded_tree().body
                      if isinstance(node, ast.FunctionDef) and node.name == 'close_verified_run_target')
        self.assertFalse(any(isinstance(n, ast.Attribute) and n.attr == 'close' for n in ast.walk(helper)))


class ResavePage:
    """Mock browser boundaries; execute the actual embedded resave implementation."""
    def __init__(self, scenario):
        self.scenario = scenario
        self.submitted = False
        self.url_reads = 0
        self.cleanup_calls = 0
        self.cleanup_error_after = 0

    def goto(self, *args, **kwargs):
        pass

    def add_script_tag(self, **kwargs):
        pass

    @property
    def url(self):
        self.url_reads += 1
        if self.scenario == 'navigation_error':
            raise RuntimeError('navigation unavailable')
        if self.scenario == 'confirmed' and self.submitted and self.url_reads >= 2:
            return 'https://example.test/manage/posts/'
        if self.scenario in ('missing_radio', 'missing_button', 'dialog_error', 'dialog_timeout'):
            return 'https://example.test/manage/posts'
        if self.scenario == 'return_url_only':
            return 'https://example.test/manage/newpost/123?returnURL=/manage/posts/'
        return 'https://example.test/manage/newpost/123'

    def evaluate(self, script):
        if 'cleanupOGResiduals' in script:
            self.cleanup_calls += 1
            if self.scenario == 'cleanup_error' and self.cleanup_calls > self.cleanup_error_after:
                raise RuntimeError('cleanup evaluation failed')
            return {}
        if 'activeEditor.save' in script:
            if self.scenario == 'editor_save_error':
                raise RuntimeError('editor save failed')
            return 'ok'
        if "? 'yes' : 'no'" in script:
            if self.scenario == 'dialog_error':
                raise RuntimeError('dialog evaluation failed')
            return 'no' if self.scenario == 'dialog_timeout' else 'yes'
        if 'input[type=radio]' in script:
            if self.scenario == 'radio_error':
                raise RuntimeError('radio click failed')
            return self.scenario != 'missing_radio'
        if "querySelectorAll('button')" in script:
            if self.scenario == 'submit_error':
                raise RuntimeError('submit failed')
            self.submitted = self.scenario != 'missing_button'
            return self.submitted
        if "? 'open' : 'closed'" in script:
            if self.scenario == 'poll_error':
                raise RuntimeError('outcome poll failed')
            return 'closed' if self.scenario == 'dialog_disappeared' else 'open'
        raise AssertionError(script)


class RealResaveCleanupTests(unittest.TestCase):
    scenarios = ('confirmed', 'submit_error', 'radio_error', 'missing_radio',
                 'missing_button', 'dialog_error', 'dialog_timeout',
                 'navigation_error', 'timeout', 'return_url_only',
                 'dialog_disappeared', 'poll_error', 'cleanup_error',
                 'editor_save_error', 'complete_error')

    def prepare(self, private, scenario, template='mk-review'):
        ns = load_cleanup_helpers()
        tree = embedded_tree()
        helper = next(n for n in tree.body if isinstance(n, ast.FunctionDef)
                      and n.name == 'republish_current_editor')
        exec(compile(ast.Module(body=[helper], type_ignores=[]), str(SCRIPT_PATH), 'exec'), ns)
        block = next(n for n in tree.body if isinstance(n, ast.With))
        step10 = next(n for n in block.body if isinstance(n, ast.If)
                      and isinstance(n.test, ast.BoolOp)
                      and [getattr(v, 'id', None) for v in n.test.values] == ['post_info', 'og_entries'])
        start = next(i for i, n in enumerate(block.body) if isinstance(n, ast.Assign)
                     and any(isinstance(t, ast.Name) and t.id == 'result' for t in n.targets))
        end = next(i for i, n in enumerate(block.body) if isinstance(n, ast.Expr)
                   and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Name)
                   and n.value.func.id == 'close_verified_run_target')
        code = compile(ast.Module(body=[step10] + block.body[start:end + 1], type_ignores=[]),
                       str(SCRIPT_PATH), 'exec')

        def complete(page):
            if scenario == 'complete_error':
                raise RuntimeError('complete click failed')

        ns.update(page=ResavePage(scenario), TEMPLATE=template, PRIVATE=private,
                  post_info={'id': '123', 'url': 'https://example.test/123'},
                  og_entries=['placeholder'], BLOG='example.test', HELPER_JS='helper.js',
                  wait_tinymce=lambda *a, **k: True,
                  ensure_tinymce_ready=lambda *a, **k: None, click_complete_button=complete,
                  inspect_gap=lambda *a: {'gapPersists': False}, urlsplit=urlsplit,
                  time=SimpleNamespace(sleep=lambda *a: None), warning=None,
                  post_publish_uncertain=False, run_page_target_id='run', json=json,
                  final_url='manage/posts', elapsed=123, PUBLIC_BASE_URL='', gap_check=None,
                  og_render_summary=None, draft_og_gate=None, public_og_gate=None,
                  HARD_FAIL=None, sys=__import__('sys'))
        return ns, code

    def test_real_helper_public_and_private_confirmation_and_legacy_returns(self):
        for private in (False, True):
            for scenario in self.scenarios:
                with self.subTest(private=private, scenario=scenario):
                    ns, _ = self.prepare(private, scenario)
                    evidence = {'confirmed': True}  # Stale evidence must be reset.
                    helper = ns['republish_current_editor']
                    if scenario in ('cleanup_error', 'editor_save_error', 'complete_error'):
                        with self.assertRaises(RuntimeError):
                            helper(ns['page'], private, save_confirmation=evidence)
                        self.assertIs(evidence['confirmed'], False)
                        continue
                    saved = helper(ns['page'], private, save_confirmation=evidence)
                    self.assertEqual(evidence['confirmed'], scenario == 'confirmed')
                    legacy_ns, _ = self.prepare(private, scenario)
                    legacy_saved = legacy_ns['republish_current_editor'](legacy_ns['page'], private)
                    self.assertEqual(saved, legacy_saved)
                    expected = not (private and scenario == 'timeout')
                    self.assertEqual(saved, expected)
                    if scenario == 'timeout':
                        self.assertEqual(ns['page'].url_reads, 20)

    def test_real_helper_step10_and_actual_result_cleanup_tail(self):
        for template in ('mk-review', 'daum-trends', 'simple-post'):
            for private in (False, True):
                for scenario in self.scenarios:
                    with self.subTest(template=template, private=private, scenario=scenario):
                        ns, code = self.prepare(private, scenario, template)
                        ns['page'].cleanup_error_after = 1  # Fail inside the real helper.
                        with patch('builtins.print'):
                            exec(code, ns)
                        expected_close = template == 'daum-trends' or (
                            template == 'mk-review' and scenario == 'confirmed')
                        self.assertEqual(bool(ns['closes']), expected_close)
                        self.assertIs(ns['result']['success'], True)
                        self.assertIsNone(ns['HARD_FAIL'])
                        expected_warning = ('post_publish_resave_failed'
                                            if private and scenario == 'timeout' else None)
                        self.assertEqual(ns['result'].get('warning'), expected_warning)
                        if template == 'mk-review' and scenario != 'confirmed':
                            self.assertTrue(ns['post_publish_uncertain'])
                        if template != 'mk-review':
                            self.assertNotIn('save_confirmation', ns)


class FakeClock:
    def __init__(self):
        self.now = 0
        self.sleeps = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class FakeHTTP:
    def __init__(self, snapshots, close_error=None, clock=None, request_seconds=0):
        self.snapshots = iter(snapshots)
        self.last = None
        self.calls = []
        self.close_error = close_error
        self.clock = clock
        self.request_seconds = request_seconds

    def open(self, url, timeout):
        self.calls.append((url, timeout))
        self.clock.now += self.request_seconds
        if '/json/close/' in url:
            if self.close_error:
                raise self.close_error
            raw = b'Target is closing'  # Acknowledgement alone is never proof.
        else:
            self.last = next(self.snapshots, self.last)
            raw = json.dumps(self.last).encode()
        response = unittest.mock.MagicMock()
        response.__enter__.return_value.read.return_value = raw
        return response


class ClosureConfirmationTests(unittest.TestCase):
    user = {'id': 'user', 'type': 'page', 'url': 'https://example.test/manage/posts'}
    run_target = {'id': 'run', 'type': 'page', 'url': 'https://example.test/manage/posts'}

    def worker(self, snapshots, close_error=None, request_seconds=0):
        clock = FakeClock()
        http = FakeHTTP(snapshots, close_error, clock, request_seconds)
        with patch.object(WORKER.urllib.request, 'build_opener', return_value=http), patch.object(WORKER, 'time', clock):
            status = WORKER.close_target(9222, 'run')
        return status, http, clock

    def test_delayed_disappearance_only_closes_exact_run_and_keeps_user(self):
        status, http, clock = self.worker(
            [[self.user, self.run_target]] * 3 + [[self.user]])
        self.assertEqual(status, 'closed')
        self.assertEqual(clock.sleeps, [1.0, 2.0])
        self.assertEqual([url for url, _ in http.calls if '/close/' in url],
                         ['http://127.0.0.1:9222/json/close/run'])
        self.assertEqual(http.last, [self.user])

    def test_close_acknowledgement_without_disappearance_is_bounded_unconfirmed(self):
        status, http, clock = self.worker([[self.user, self.run_target]])
        self.assertEqual(status, 'unconfirmed')
        self.assertEqual(clock.now, 4.5)
        self.assertEqual(clock.sleeps, [1.0, 2.0, 1.5])
        self.assertEqual(len(http.calls), 5)
        self.assertTrue(all(0 < timeout <= .75 for _, timeout in http.calls))
        self.assertEqual(sum('/close/' in url for url, _ in http.calls), 1)

    def test_backoff_and_request_timeout_use_remaining_worker_deadline(self):
        status, http, clock = self.worker([[self.run_target]], request_seconds=.25)
        self.assertEqual(status, 'unconfirmed')
        self.assertEqual(clock.sleeps, [1.0, 2.0, .25])
        self.assertEqual(clock.now, 4.5)
        self.assertEqual([timeout for _, timeout in http.calls], [.75] * 4 + [.5])

    def test_lost_close_response_can_be_confirmed_by_disappearance(self):
        status, _, _ = self.worker([[self.run_target], []], TimeoutError())
        self.assertEqual(status, 'closed')

    def test_missing_mismatch_duplicate_never_close_user_tabs(self):
        for snapshot, expected in (([self.user], 'target_missing'),
                                   ([dict(self.run_target, type='worker'), self.user], 'identity_mismatch'),
                                   ([self.run_target, self.run_target], 'identity_mismatch')):
            status, http, _ = self.worker([snapshot])
            self.assertEqual(status, expected)
            self.assertFalse(any('/close/' in url for url, _ in http.calls))

    def test_malformed_or_failed_confirmation_never_means_closed(self):
        for snapshot in ({}, [{}], [{'id': None}]):
            status, _, _ = self.worker([[self.run_target], snapshot])
            self.assertEqual(status, 'unconfirmed')
        status, _, _ = self.worker([[self.run_target]], TimeoutError())
        self.assertEqual(status, 'unconfirmed')

    def test_parent_hard_timeout_and_worker_failure_are_nonfatal(self):
        with patch.object(WORKER.subprocess, 'run', side_effect=subprocess.TimeoutExpired('worker', 5)) as run:
            self.assertEqual(WORKER.cleanup_owned_target('9222', 'run'), 'timeout')
            self.assertEqual(run.call_args.kwargs['timeout'], 5)
        for response in (subprocess.CompletedProcess([], 0, b'closed\n'),
                         subprocess.CompletedProcess([], 1, b'closed\n'),
                         subprocess.CompletedProcess([], 0, b'unexpected\n')):
            with patch.object(WORKER.subprocess, 'run', return_value=response):
                self.assertEqual(WORKER.cleanup_owned_target('9222', 'run'),
                                 'closed' if response.returncode == 0 and response.stdout == b'closed\n' else 'unconfirmed')


if __name__ == '__main__':
    unittest.main()
