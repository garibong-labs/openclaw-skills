"""Offline Stage3 tests. Optional real Stage2 integration: MK_STAGE2_DIR +
MK_STAGE2_PYTHON (absolute Python with Pillow). No browser/network/engine calls.
"""
import ast
import copy
from html import escape
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import warnings

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
spec = importlib.util.spec_from_file_location('mk_stage3', SCRIPTS / 'mk_article_image_publisher.py')
stage3 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage3)


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')


def embedded():
    source = (SCRIPTS / 'publish-post.sh').read_text()
    source = re.search(r"<< 'PYTHON_SCRIPT'\n(.*?)\nPYTHON_SCRIPT\n", source, re.S)[1]
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', SyntaxWarning)
        return ast.parse(source)


def failure_adapter(phase):
    adapter = object.__new__(stage3.MKArticleImages)
    adapter.enabled = adapter.ready = True
    adapter.submitted = False
    adapter.post_url = adapter.post_id = None
    adapter.phase = phase
    adapter.write = Mock()
    return adapter


def failure_namespace(adapter, post_info=None):
    functions = [n for n in embedded().body if isinstance(n, ast.FunctionDef)
                 and n.name in ('fail', 'mk_failure_result')]
    ns = dict(mk_images=adapter, post_info=post_info, public_url_for=lambda url: url, sys=sys, json=json)
    exec(compile(ast.Module(body=functions, type_ignores=[]), 'actual-failure-functions', 'exec'), ns)
    return ns


def og_namespace(adapter, process):
    functions = [n for n in embedded().body if isinstance(n, ast.FunctionDef)
                 and n.name in ('fail', 'mk_failure_result', 'should_run_og_gate', 'run_og_gate')]
    ns = dict(mk_images=adapter, post_info=None, public_url_for=lambda url: url,
              sys=sys, json=json, Path=Path, subprocess=process, log=Mock(),
              OG_GATE_ENABLED=True, OG_VALIDATOR=str(adapter.validator), BODY_FILE=str(adapter.body),
              bounded_diagnostic=stage3.bounded_diagnostic)
    exec(compile(ast.Module(body=functions, type_ignores=[]), 'actual-og-functions', 'exec'), ns)
    return ns


class ContractTests(unittest.TestCase):
    def test_actual_legacy_guard_distinguishes_dependency_input_and_marker_failures(self):
        legacy = (SCRIPTS / 'publish.sh').read_text()
        guard = legacy[legacy.index('if python3 - "$SCRIPT_DIR"'):legacy.index('# ── SEO 검사')]
        fail_function = next(line for line in legacy.splitlines() if line.startswith('fail()'))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            missing = root / 'missing'; missing.mkdir()
            broken = root / 'broken'; broken.mkdir()
            (broken / 'mk_article_image_publisher.py').write_text('raise ImportError("token=private-import-secret")')
            invalid = root / 'invalid.html'; invalid.write_bytes(b'\xff\xfe')
            body = root / 'body.html'; body.write_text('<p>valid</p>')
            cases = [(missing, body, 'infrastructure-failed', 'dependency-failed'),
                     (broken, body, 'infrastructure-failed', 'dependency-failed'),
                     (SCRIPTS, invalid, 'input-unreadable', 'input-unreadable'),
                     (SCRIPTS, root / 'absent.html', 'input-unreadable', 'input-unreadable')]
            forbidden = root / 'forbidden.html'; forbidden.write_text('<p data-image-marker="mk-article-1"/>')
            cases.append((SCRIPTS, forbidden, 'forbidden-markers', 'forbidden-markers'))
            source = 'set -eu\n' + fail_function + '\n' + guard + '\necho browser-entry\n'
            for directory, path, code, diagnostic in cases:
                with self.subTest(code=code, directory=directory, path=path):
                    env = dict(os.environ, SCRIPT_DIR=str(directory), BODY_FILE=str(path), TEMPLATE='',
                               PYTHONPATH='', TEST_API_TOKEN='private-import-secret')
                    proc = subprocess.run(['bash'], input=source, text=True, capture_output=True, cwd=tmp, env=env)
                    self.assertEqual(proc.returncode, 1)
                    self.assertEqual(json.loads(proc.stdout)['success'], False)
                    self.assertIn('legacy-guard/' + code, json.loads(proc.stdout)['error'])
                    self.assertEqual(proc.stderr.strip(), 'legacy-guard/' + diagnostic)
                    self.assertNotIn('browser-entry', proc.stdout)
                    self.assertNotIn('private-import-secret', proc.stdout + proc.stderr)
                    self.assertLess(len(proc.stdout + proc.stderr), 400)
            for template in ('', 'simple-post', 'mk-review', 'daum-trends'):
                for html in ('<p>valid legacy body</p>', '<p data-image-marker="trend-image-1"/>'):
                    body.write_text(html)
                    env = dict(os.environ, SCRIPT_DIR=str(SCRIPTS), BODY_FILE=str(body), TEMPLATE=template)
                    proc = subprocess.run(['bash'], input=source, text=True, capture_output=True, cwd=tmp, env=env)
                    self.assertEqual(proc.returncode, 0, proc.stderr)
                    self.assertEqual(proc.stdout.strip(), 'browser-entry')

    def test_both_publishers_accept_legacy_markers_and_reject_mk_attributes(self):
        legacy = (SCRIPTS / 'publish.sh').read_text()
        guard = re.search(r"<<'MK_DRAFT_GUARD'\n(.*?)\nMK_DRAFT_GUARD", legacy, re.S)[1]
        with tempfile.TemporaryDirectory() as tmp:
            body = Path(tmp) / 'body.html'
            options = dict(enabled=False, private=False, body=body, current='', run_dir='',
                           validator='', interpreter='', sources='', evidence_dir='', banner='', banner_alt='')
            for template in ('', 'simple-post', 'daum-trends', 'mk-review'):
                for html, accepted in (('<p data-image-marker="trend-image-1"/>', True),
                                       ('<p data-image-marker="mk-article-1"/>', False),
                                       ('<p data-image-marker="trend-image-1" data-article-id="mk-1"/>', False)):
                    with self.subTest(template=template, html=html):
                        body.write_text(html)
                        if accepted:
                            stage3.MKArticleImages(template=template, legacy_images='/image.jpg', **options)
                        else:
                            with self.assertRaises(stage3.ImagePublishError):
                                stage3.MKArticleImages(template=template, **options)
                        proc = subprocess.run([sys.executable, '-', str(SCRIPTS), str(body), template],
                                              input=guard, capture_output=True, text=True)
                        self.assertEqual(proc.returncode == 0, accepted, proc.stderr)

    def test_legacy_marker_guard_including_no_template_and_self_closing(self):
        for template in ('', 'mk-review', 'simple-post', 'daum-trends'):
            for marker in ('trend-image-1', 'trend-image-12'):
                stage3.guard_legacy_markers('<p data-image-marker="%s"/>' % marker, template)
            for marker in ('mk-image-1', 'arbitrary', 'trend-image-0', 'trend-image-1-extra'):
                with self.subTest(template=template, marker=marker), self.assertRaises(stage3.ImagePublishError):
                    stage3.guard_legacy_markers('<p data-image-marker="%s"/>' % marker, template)
            with self.subTest(template=template), self.assertRaises(stage3.ImagePublishError):
                stage3.guard_legacy_markers('<p data-image-marker="mk-image-1" data-image-marker="trend-image-1"/>', template)
            for attr in ('data-image-alt', 'data-image-caption', 'data-article-id'):
                with self.subTest(template=template, attr=attr), self.assertRaises(stage3.ImagePublishError):
                    stage3.guard_legacy_markers('<p %s="x"/>' % attr, template)
        with self.assertRaises(stage3.ImagePublishError):
            stage3.guard_legacy_markers('<p data-image-marker="arbitrary"></p>', '')
        stage3.guard_legacy_markers('<p data-image-marker="trend-image-1"></p>', 'daum-trends')
        stage3.guard_legacy_markers('<h2>legacy OG only</h2>', 'mk-review')

    def test_flags_never_silently_fall_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            body = Path(tmp) / 'body.html'
            body.write_text('<p>legacy</p>')
            base = dict(enabled=True, template='mk-review', private=False, body=body,
                        current='', run_dir='', validator='', interpreter='', sources='',
                        evidence_dir='', banner='', banner_alt='')
            with self.assertRaises(stage3.ImagePublishError):
                stage3.MKArticleImages(**base)
            for missing in ('current', 'run_dir', 'validator', 'interpreter', 'sources', 'evidence_dir'):
                options = dict(base, current='/current', run_dir='/run', validator='/validator',
                               interpreter='/python', sources='/sources', evidence_dir='/new', banner='/banner', banner_alt='banner')
                options[missing] = ''
                with self.subTest(missing=missing), self.assertRaises(stage3.ImagePublishError):
                    stage3.MKArticleImages(**options)
            for key in ('current', 'run_dir', 'validator', 'interpreter', 'sources', 'evidence_dir', 'selector'):
                options = dict(base, enabled=False)
                options[key] = '/does-not-exist'
                with self.subTest(key=key), self.assertRaises(stage3.ImagePublishError):
                    stage3.MKArticleImages(**options)

    def test_actual_orchestrator_phase_order_and_no_resave_for_mk_images(self):
        tree = embedded()
        block = next(n for n in tree.body if isinstance(n, ast.With))
        # Pin actual wiring and branch guards, not a duplicated orchestrator.
        calls = {}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                name = ast.unparse(node.func)
                calls.setdefault(name, []).append(node.lineno)
        self.assertLess(calls['MKArticleImages'][0], block.lineno)
        self.assertLess(block.lineno, calls['mk_images.upload_articles'][0])
        order = ['mk_images.upload_articles', 'mk_images.upload_banner', 'select_mk_banner_representative', 'mk_images.editor_gate',
                 'click_complete_button', 'mk_images.before_submit', 'mk_images.confirm_publication', 'mk_images.public_gate']
        # Global helper definitions contain click_complete_button calls too.
        self.assertLess(calls['mk_images.editor_gate'][0], max(calls['click_complete_button']))
        relevant = [max(calls[k]) for k in order if k != 'click_complete_button']
        self.assertEqual(relevant, sorted(relevant))
        cleanup = next(n for n in block.body if isinstance(n, ast.If) and isinstance(n.test, ast.BoolOp)
                       and ast.unparse(n.test).startswith('post_info and og_entries'))
        self.assertIn('not mk_images.enabled', ast.unparse(cleanup.test))
        ns = dict(mk_images=SimpleNamespace(enabled=True), post_info={'id': '123'}, og_entries=['x'])
        # No page, resave function or network objects exist: branch must be inert.
        exec(compile(ast.Module(body=[cleanup], type_ignores=[]), 'step10', 'exec'), ns)

    def test_actual_failure_handler_preserves_early_confirmed_publication(self):
        adapter = object.__new__(stage3.MKArticleImages)
        adapter.enabled = True
        adapter.post_url = adapter.post_id = None
        adapter.phase = 'submit'
        adapter.submitted = True
        adapter.ready = True
        adapter.write = Mock()
        functions = [n for n in embedded().body if isinstance(n, ast.FunctionDef)
                     and n.name in ('fail', 'mk_failure_result')]
        ns = dict(mk_images=adapter, post_info={'url': 'https://blog.example/456', 'id': '456'},
                  public_url_for=lambda url: url, sys=sys, json=json)
        exec(compile(ast.Module(body=functions, type_ignores=[]), 'failure', 'exec'), ns)
        with patch('builtins.print') as output, self.assertRaises(SystemExit):
            ns['fail']('post-confirmation navigation failed')
        result = json.loads(output.call_args.args[0])
        self.assertFalse(result['success'])
        self.assertEqual(result['postUrl'], 'https://blog.example/456')
        self.assertEqual(result['postId'], '456')
        self.assertTrue(result['submitted'])
        self.assertFalse(result['automaticRetryAllowed'])
        self.assertEqual(result['phase'], 'submit')
        self.assertEqual(result['error'], 'mk-images/submit-failed')
        self.assertEqual(result['detail'], 'post-confirmation navigation failed')
        self.assertEqual(adapter.write.call_args.args[1]['phase'], 'submit')
        self.assertEqual(adapter.write.call_args.args[1]['postId'], '456')

    def test_actual_tag_and_publish_fail_calls_preserve_bounded_cause_and_original_phase(self):
        block = next(n for n in embedded().body if isinstance(n, ast.With))
        tags = next(n for n in block.body if isinstance(n, ast.If) and ast.unparse(n.test) == 'TAGS_STR')
        dialog = next(n for n in block.body if isinstance(n, ast.If) and ast.unparse(n.test) == "dlg != 'yes' and (not PRIVATE)")
        for node, phase, expected in ((tags, 'representative', 'page closed before tag step'),
                                      (dialog, 'editor', 'publish dialog not found after 10s')):
            adapter = failure_adapter(phase)
            ns = failure_namespace(adapter, {'url': 'https://blog.example/456', 'id': '456'})
            ns.update(TAGS_STR='tag', page=Mock(), dlg='no', PRIVATE=False, log=Mock())
            ns['page'].is_closed.return_value = True
            with self.subTest(phase=phase), patch('builtins.print') as output, self.assertRaises(SystemExit):
                exec(compile(ast.Module(body=[node], type_ignores=[]), 'actual-step-failure', 'exec'), ns)
            result = json.loads(output.call_args.args[0])
            self.assertEqual(result['phase'], phase)
            self.assertEqual(result['detail'], expected)
            self.assertEqual(result['postUrl'], 'https://blog.example/456')
            self.assertEqual(result['postId'], '456')
            self.assertFalse(result['automaticRetryAllowed'])
            self.assertEqual(adapter.write.call_args.args[1], result)

        adapter = failure_adapter('representative')
        ns = failure_namespace(adapter)
        with patch.dict(os.environ, TEST_API_TOKEN='private-secret'), patch('builtins.print') as output, self.assertRaises(SystemExit):
            ns['fail']('caller/specific-code: private-secret password="two word secret" ' + 'x' * 3000)
        result = json.loads(output.call_args.args[0])
        self.assertIn('caller/specific-code', result['detail'])
        self.assertNotIn('private-secret', result['detail'])
        self.assertNotIn('two word secret', result['detail'])
        self.assertLessEqual(len(result['detail']), 520)
        self.assertEqual(adapter.write.call_args.args[1], result)

    def test_identity_recovery_cannot_overwrite_failure_phase_even_when_recovery_raises(self):
        for error in (None, OSError('state write failed')):
            adapter = failure_adapter('editor')
            def confirm(url, post_id):
                adapter.post_url, adapter.post_id = url, post_id
                adapter.phase = 'public'
                if error:
                    raise error
            adapter.confirm_publication = confirm
            ns = failure_namespace(adapter, {'url': 'https://blog.example/456', 'id': '456'})
            result = ns['mk_failure_result']('original caller error')
            self.assertEqual(result['phase'], 'editor')
            self.assertEqual(result['detail'], 'original caller error')
            self.assertEqual(result['postId'], '456')

    def test_before_submit_runs_real_editor_gate_and_failure_never_mints_submission(self):
        adapter = object.__new__(stage3.MKArticleImages)
        adapter.editor_gate = Mock(side_effect=stage3.ImagePublishError('editor rejected'))
        adapter.check_binding = Mock()
        adapter.write = Mock()
        adapter.submitted = False
        with self.assertRaises(stage3.ImagePublishError):
            adapter.before_submit(object())
        self.assertFalse(adapter.submitted)
        adapter.write.assert_not_called()

    def test_strict_file_delivery_does_not_retry_after_ambiguous_chooser_error(self):
        # Reuse the real embedded upload function with a chooser that might
        # already have accepted the bytes when it raises.
        helper = next(n for n in embedded().body if isinstance(n, ast.FunctionDef) and n.name == 'upload_editor_image')
        chooser = Mock()
        chooser.value.set_files.side_effect = RuntimeError('uncertain delivery')
        chooser.__enter__ = Mock(return_value=chooser)
        chooser.__exit__ = Mock(return_value=False)
        page = Mock()
        page.expect_file_chooser.return_value = chooser
        find_input = Mock()
        ns = dict(open_attach_image_menu=Mock(), find_image_file_input=find_input, log=Mock())
        exec(compile(ast.Module(body=[helper], type_ignores=[]), 'upload', 'exec'), ns)
        with self.assertRaisesRegex(RuntimeError, 'no second file delivery'):
            ns['upload_editor_image'](page, {'buffer': b'bytes'}, 'MK', single_delivery=True)
        self.assertEqual(page.expect_file_chooser.call_count, 1)
        find_input.assert_not_called()


class OGWiringTests(unittest.TestCase):
    def setUp(self):
        self.tree = embedded()
        self.adapter = SimpleNamespace(enabled=True, phase='draft', post_url='https://blog.example/123',
                                       draft_validation={'success': True, 'images': {'verified': 4}},
                                       public_gate=Mock(return_value={'success': True, 'images': {'verified': 4}}))
        def fail(message):
            raise stage3.ImagePublishError(message)
        self.ns = dict(mk_images=self.adapter, should_run_og_gate=lambda: self.configured,
                       run_og_gate=Mock(side_effect=lambda mode, *args: {'success': True, 'count': 4, 'card_count': 4}),
                       log=Mock(), fail=fail, draft_og_gate=None, public_og_gate=None, public_image_gate=None,
                       post_info={'url': 'https://blog.example/123', 'id': '123'}, PRIVATE=False)
        self.configured = False

    def preflight(self):
        start = next(i for i, n in enumerate(self.tree.body) if isinstance(n, ast.Try)
                     and any(isinstance(c, ast.Call) and isinstance(c.func, ast.Name)
                             and c.func.id == 'MKArticleImages' for c in ast.walk(n)))
        branch = self.tree.body[start + 1]
        exec(compile(ast.Module(body=[branch], type_ignores=[]), 'actual-og-preflight', 'exec'), self.ns)

    def public(self):
        block = next(n for n in self.tree.body if isinstance(n, ast.With))
        branch = next(n for n in block.body if isinstance(n, ast.If)
                      and any(isinstance(c, ast.Call) and ast.unparse(c.func) == 'mk_images.public_gate'
                              for c in ast.walk(n)))
        exec(compile(ast.Module(body=[branch], type_ignores=[]), 'actual-public-gates', 'exec'), self.ns)

    def result(self):
        block = next(n for n in self.tree.body if isinstance(n, ast.With))
        start = next(i for i, n in enumerate(block.body) if isinstance(n, ast.Assign)
                     and any(isinstance(t, ast.Name) and t.id == 'result' for t in n.targets))
        stop = next(i for i in range(start, len(block.body)) if isinstance(block.body[i], ast.If)
                    and ast.unparse(block.body[i].test) == 'HARD_FAIL')
        self.ns.update(final_url='https://blog.example/manage/posts', elapsed=1, PUBLIC_BASE_URL='',
                       gap_check=None, og_render_summary=None, warning=None)
        exec(compile(ast.Module(body=block.body[start:stop], type_ignores=[]), 'actual-result', 'exec'), self.ns)
        return self.ns['result']

    def test_unconfigured_og_never_claims_success_for_image_proofs(self):
        self.preflight()
        self.public()
        result = self.result()
        self.ns['run_og_gate'].assert_not_called()
        self.assertNotIn('draftOgValidation', result)
        self.assertNotIn('publicOgValidation', result)
        self.assertEqual(result['articleImageValidation']['public']['images']['verified'], 4)

    def test_configured_draft_and_public_og_both_run_and_report_actual_results(self):
        self.configured = True
        self.preflight()
        self.public()
        self.assertEqual(self.ns['run_og_gate'].call_args_list,
                         [unittest.mock.call('draft'), unittest.mock.call('public', 'https://blog.example/123')])
        result = self.result()
        self.assertEqual(result['draftOgValidation'], {'success': True, 'count': 4})
        self.assertEqual(result['publicOgValidation'], {'success': True, 'cardCount': 4})

    def test_configured_draft_rejection_stops_before_browser(self):
        self.configured = True
        self.ns['run_og_gate'].side_effect = stage3.ImagePublishError('strict OG rejected')
        browser_entry = Mock()
        with self.assertRaises(stage3.ImagePublishError):
            self.preflight()
            browser_entry()
        browser_entry.assert_not_called()

    def test_configured_public_rejection_cannot_become_success_or_resubmit(self):
        self.configured = True
        self.ns['run_og_gate'].side_effect = stage3.ImagePublishError('strict OG public rejected')
        cleanup_or_resubmit = Mock()
        with self.assertRaises(stage3.ImagePublishError):
            self.public()
            cleanup_or_resubmit()
        cleanup_or_resubmit.assert_not_called()


class MKRepresentativeTests(unittest.TestCase):
    """Execute the real Step6 branch; no browser or publication is performed."""
    src = 'https://cdn.example/opaque-upload?signature=keep%2Fall&v=2'

    def run_step6(self, result=None, src=None, skip='', enabled=True, template='mk-review', error=None, adapter=None):
        tree = embedded()
        helper = next(n for n in tree.body if isinstance(n, ast.FunctionDef)
                      and n.name == 'select_mk_banner_representative')
        step = next(n for n in ast.walk(tree) if isinstance(n, ast.If)
                    and ast.unparse(n.test) == 'mk_images.enabled'
                    and any(isinstance(c, ast.Call) and isinstance(c.func, ast.Name)
                            and c.func.id == helper.name for c in ast.walk(n)))
        self.page = Mock()
        self.page.evaluate.return_value = result
        self.page.evaluate.side_effect = error
        self.submit = Mock()
        self.resolve = Mock(return_value='01-trend.jpg' if template == 'daum-trends' else None)
        def fail(message):
            raise stage3.ImagePublishError(message)
        ns = dict(page=self.page, mk_images=SimpleNamespace(enabled=enabled, banner_src=src),
                  os=SimpleNamespace(environ={'TISTORY_SKIP_REPRESENT_IMAGE': skip}, path=os.path),
                  fail=fail, log=Mock(), time=Mock(), json=json, TEMPLATE=template,
                  bounded_diagnostic=stage3.bounded_diagnostic,
                  image_files=['01-trend.jpg'], resolve_represent_image_target=self.resolve,
                  submit=self.submit)
        if adapter is not None:
            ns.update(failure_namespace(adapter))
            adapter.banner_src = src
        # The sentinel stands for all later submit work and must remain untouched on failure.
        module = ast.Module(body=[helper, step, ast.parse('submit()').body[0]], type_ignores=[])
        exec(compile(module, 'actual-step6', 'exec'), ns)

    def test_actual_step6_fail_to_json_and_state_preserves_representative_code_and_detail(self):
        adapter = failure_adapter('banner')
        with patch.dict(os.environ, TEST_API_TOKEN='private-secret'), patch('builtins.print') as output, self.assertRaises(SystemExit):
            self.run_step6({'success': False, 'error': 'button missing token="private-secret"'}, src=self.src, adapter=adapter)
        result = json.loads(output.call_args.args[0])
        self.assertEqual(result['phase'], 'representative')
        self.assertEqual(result['error'], 'mk-images/representative-failed')
        self.assertIn('mk-images/representative-banner-selection-failed', result['detail'])
        self.assertIn('button missing', result['detail'])
        self.assertNotIn('private-secret', result['detail'])
        self.assertFalse(result['automaticRetryAllowed'])
        self.assertEqual(adapter.write.call_args.args[1], result)
        self.submit.assert_not_called()

    def test_exact_observed_banner_src_passed_and_matching_success_required(self):
        self.run_step6({'success': True, 'imageUrl': self.src}, src=self.src)
        expression, argument = self.page.evaluate.call_args.args
        self.assertIn('targetSrc: src', expression)
        self.assertNotIn('targetFilename', expression)
        self.assertEqual(argument, self.src)
        self.resolve.assert_not_called()
        self.submit.assert_called_once()

    def test_selection_failure_missing_helper_wrong_target_and_malformed_result_stop_submit(self):
        for result in (None, False, {}, {'success': False}, {'success': True},
                       {'success': 1, 'imageUrl': self.src},
                       {'success': True, 'imageUrl': self.src + '&other=1'},
                       {'success': False, 'error': 'target missing or ambiguous'},
                       {'success': False, 'error': 'represent button not found'}):
            with self.subTest(result=result), self.assertRaisesRegex(stage3.ImagePublishError, 'selection-failed'):
                self.run_step6(result, src=self.src)
            self.submit.assert_not_called()

    def test_missing_observed_src_never_evaluates_or_submits(self):
        for src in (None, '', 123, 'blob:pending', 'data:image/png;base64,x'):
            with self.subTest(src=src), self.assertRaisesRegex(stage3.ImagePublishError, 'banner-src-missing'):
                self.run_step6(src=src)
            self.page.evaluate.assert_not_called()
            self.submit.assert_not_called()

    def test_skip_setting_refused_in_mk_before_any_selection_or_submit(self):
        for skip in ('1', 'true', 'yes', 'TRUE', 'Yes'):
            with self.subTest(skip=skip), self.assertRaisesRegex(stage3.ImagePublishError, 'skip-forbidden'):
                self.run_step6(src=self.src, skip=skip)
            self.page.evaluate.assert_not_called()
            self.submit.assert_not_called()

    def test_selection_exception_stops_submit(self):
        with self.assertRaisesRegex(RuntimeError, 'dispatch failed'):
            self.run_step6(src=self.src, error=RuntimeError('dispatch failed'))
        self.submit.assert_not_called()

    def test_legacy_skip_generic_and_daum_branches_preserved(self):
        self.run_step6(enabled=False, skip='true')
        self.page.evaluate.assert_not_called()
        self.submit.assert_called_once()
        self.run_step6(enabled=False)
        self.assertEqual(len(self.page.evaluate.call_args.args), 1)
        self.assertIn('setRepresentImageFromEditor()', self.page.evaluate.call_args.args[0])
        self.run_step6({'success': True}, enabled=False, template='daum-trends')
        self.assertIn('targetFilename: target', self.page.evaluate.call_args.args[0])
        self.assertEqual(self.page.evaluate.call_args.args[1], '01-trend.jpg')
        with self.assertRaisesRegex(stage3.ImagePublishError, 'selection failed'):
            self.run_step6({'success': False}, enabled=False, template='daum-trends')
        self.submit.assert_not_called()


class FakeEditor:
    """Returns an operation result, independent of filename or later DOM scans."""
    def __init__(self, bundle):
        self.bundle = bundle
        self.token = None
        self.entry = None
        self.srcs = []
        self.uploads = []
        self.snapshot = ''
        self.calls = []
        self.return_src = None

    def evaluate(self, expression, arg=None):
        self.calls.append(expression)
        if 'beginMKImageUpload' in expression:
            self.token = arg
        elif 'finishMKImageUpload' in expression:
            if arg['token'] != self.token:
                raise AssertionError('wrong operation token')
            self.entry = arg['entry']
            index = len(self.srcs) + 1
            src = self.return_src or 'https://cdn.example/attachment-%s.jpg?token=whole-%s' % (index, index)
            self.srcs.append(src)
            return {'success': True, 'token': self.token, 'src': src}
        elif 'preserveMKOGThumbnailEvidence' in expression:
            return {'success': True}
        elif 'getContent' in expression:
            return self.snapshot
        else:
            raise AssertionError(expression)

    def wait_for_function(self, expression, *, arg, timeout, polling):
        assert arg == self.token and timeout == 30000 and polling == 250

    def upload(self, page, payload, context, **options):
        assert page is self and options == {'single_delivery': True}
        self.uploads.append(payload)


def make_bundle(tmp, directory):
    # Read the reference modules, create all fixtures only under TemporaryDirectory.
    sys.path.insert(0, str(directory))
    try:
        import mk_article_images as stage1
        from PIL import Image
    finally:
        sys.path.pop(0)
    data = {'schema_version': 1, 'intro': ['오프라인 합성 원고입니다.', '실제 출처와 생성 증거가 아닙니다.'], 'articles': []}
    for i in range(1, 5):
        data['articles'].append(dict(article_id='offline-%s' % i, title='합성 기사 %s 물류 협력과 지역 경제' % i,
            source_url='https://www.mk.co.kr/news/economy/9900000%s' % i,
            grounded_text=('이미지 생성이나 출처 수집을 실행하지 않은 가상의 지역 경제와 공동 창고 사례입니다. ' * 4),
            summary=['%s번 요약 첫 문단.' % i, '%s번 요약 다음 문단.' % i], comment='%s번 코멘트입니다.' % i,
            access={'fully_accessible': True, 'paid': False, 'exclude_reason': None,
                    'selector': '.news_cnt_detail_wrap', 'chars': 700, 'paragraphs': 3,
                    'checked_at': '2026-11-17T00:00:00+09:00', 'evidence_note': 'SYNTHETIC OFFLINE ONLY'}))
    stage1.validate_input(data)
    plan = stage1.plan_for(data, stage1.MODELS[0])
    run = tmp / 'run'
    run.mkdir()
    save(tmp / 'current.json', data)
    save(run / 'input.json', data)
    (run / 'body.html').write_bytes(stage1.render(data, plan))
    engine = tmp / 'identity-only-engine.py'
    engine.write_text('raise AssertionError("Never execute synthetic engine")\n')
    assets = []
    for i, entry in enumerate(plan['articles'], 1):
        output = run / entry['filename']
        Image.new('RGB', (960, 640), (i * 45, i * 15, i * 5)).save(output, 'JPEG')
        (run / entry['prompt_file']).write_text(entry['prompt'], encoding='utf-8')
        meta = {'status': 'success', 'offlineFake': False, 'prompt': {'sha256': entry['prompt_sha256']},
                'generation': {'backend': 'openclaw-infer', 'fallbackProviderUsed': False,
                'requested': {'provider': 'openai', 'model': stage1.MODELS[0], 'quality': 'medium',
                              'size': '1536x1024', 'operation': 'generate', 'timeoutMs': 5000},
                'result': {'provider': 'openai', 'model': stage1.MODELS[0].split('/')[1], 'attempts': [],
                           'ignoredOverrides': [], 'transport': 'local', 'capability': 'image.generate'}},
                'output': {'path': str(output), 'bytes': output.stat().st_size, 'sha256': stage3.digest(output.read_bytes())}}
        save(Path(str(output) + '.meta.json'), meta)
        assets.append({'status': 'verified', 'timeout': 5, **stage1.verify(output, entry, stage1.MODELS[0], False, 5)})
    save(run / 'manifest.json', {'plan': plan, 'assets': assets, 'status': 'content-complete', 'attempts': [],
         'engine': {'mode': 'generate', 'path': str(engine), 'sha256': stage3.digest(engine.read_bytes())}})
    save(tmp / 'sources.json', {e['source_url']: {'canonical': e['source_url'], 'title': e['title']} for e in plan['articles']})
    banner = tmp / 'banner.jpg'
    Image.new('RGB', (960, 640), (2, 3, 4)).save(banner, 'JPEG')
    return dict(data=data, plan=plan, run=run, tmp=tmp, banner=banner)


def render_editor(bundle, editor):
    body = (bundle['run'] / 'body.html').read_text(encoding='utf-8')
    for i, entry in enumerate(bundle['plan']['articles']):
        card = ('<figure data-ke-type="opengraph" data-og-source-url="{url}" data-og-url="{url}" '
                'data-og-title="{title}" data-og-image="https://og.example/{i}.jpg">'
                '<a href="{url}"><img src="https://og.example/{i}.jpg"></a></figure>').format(
                    url=entry['source_url'], title=escape(entry['title']), i=i)
        figure = '<figure data-ke-type="image"><img src="%s" alt="%s"><figcaption>%s</figcaption></figure>' % (
            escape(editor.srcs[i]), escape(entry['alt']), escape(entry['caption']))
        body = body.replace('<p data-og-placeholder="%s">&#8203;</p>' % entry['source_url'], card)
        body = re.sub(r'<p[^>]*data-image-marker="' + entry['marker'] + '"[^>]*>.*?</p>', lambda m: figure, body)
    return '<figure data-ke-type="image"><img src="%s" alt="독립 배너"></figure>' % escape(editor.srcs[4]) + body


class MockBoundaryTests(unittest.TestCase):
    """Always-on stdlib tests; the validator is explicitly a mock here."""
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.tmp = Path(temp.name)
        run = self.tmp / 'run'; run.mkdir()
        validator_dir = self.tmp / 'mock-validator'; validator_dir.mkdir()
        for name in ('validate-og.py', 'mk_article_images.py', 'mk_image_validation.py'):
            (validator_dir / name).write_text('# MOCK ONLY: never executed\n')
        engine = self.tmp / 'identity-only-engine.py'
        engine.write_text('raise AssertionError("must never execute engine")\n')
        (run / 'body.html').write_text('<p>MOCK Stage1 body; real validation is tested separately</p>')
        save(self.tmp / 'current.json', {'mock': True})
        save(self.tmp / 'sources.json', {'mock': True})
        plan = {'input_sha256': stage3.digest((self.tmp / 'current.json').read_bytes()), 'articles': []}
        assets = []
        for i in range(1, 5):
            entry = dict(index=i, article_id='mock-%s' % i, source_url='https://www.mk.co.kr/news/economy/%s' % i,
                         marker='trend-image-%s' % i, filename='asset-%s.jpg' % i, alt='alt %s' % i, caption='AI disclosure')
            plan['articles'].append(entry)
            output = run / entry['filename']; output.write_bytes(b'\xff\xd8\xffmock JPEG bytes ' + bytes([i]))
            assets.append({'sha256': stage3.digest(output.read_bytes())})
        save(run / 'manifest.json', {'plan': plan, 'assets': assets,
             'engine': {'path': str(engine), 'sha256': stage3.digest(engine.read_bytes())}})
        banner = self.tmp / 'banner.jpg'; banner.write_bytes(b'separate mock banner')
        self.bundle = dict(plan=plan, run=run)
        self.trace = []
        self.commands = []
        self.reject = None
        self.options = dict(enabled=True, template='mk-review', private=False, body=run / 'body.html',
            current=self.tmp / 'current.json', run_dir=run, validator=validator_dir / 'validate-og.py',
            interpreter=sys.executable, sources=self.tmp / 'sources.json', evidence_dir=self.tmp / 'evidence',
            banner=banner, banner_alt='banner', runner=self.runner)

    def runner(self, args, **kwargs):
        self.assertEqual(kwargs['env']['PYTHONDONTWRITEBYTECODE'], '1')
        self.commands.append(args)
        phase = args[2]
        self.trace.append(phase)
        success = phase != self.reject
        result = {'success': success} if phase == '--audit-banner' else {'success': success, 'mode': phase, 'images': {'verified': 4}}
        return subprocess.CompletedProcess(args, 0 if success else 1, json.dumps(result), '')

    def uploaded(self):
        adapter = stage3.MKArticleImages(**self.options)
        page = FakeEditor(self.bundle)
        page.snapshot = '<p>Mock snapshot; no real DOM proof claimed</p>'
        def upload(*args, **kwargs):
            self.trace.append('upload')
            page.upload(*args, **kwargs)
        adapter.upload_articles(page, upload)
        adapter.upload_banner(page, upload)
        return adapter, page

    def test_real_upload_method_numeric_polling_cleanup_and_no_redelivery_on_errors(self):
        for where in ('delivery', 'wait', 'finish', 'cleanup'):
            with self.subTest(where=where):
                adapter = stage3.MKArticleImages(**dict(self.options, evidence_dir=self.tmp / where))
                page = Mock()
                cause = RuntimeError('original upload cause: ' + where)
                def evaluate(expression, arg):
                    if 'finishMKImageUpload' in expression:
                        raise cause
                    if 'abortMKImageUpload' in expression and where == 'cleanup':
                        raise RuntimeError('cleanup must not mask cause')
                page.evaluate.side_effect = evaluate
                if where == 'wait':
                    cause = TimeoutError('original upload timeout')
                    page.wait_for_function.side_effect = cause
                upload = Mock(side_effect=cause if where == 'delivery' else None)
                payload = {'name': 'frozen.jpg', 'mimeType': 'image/jpeg', 'buffer': b'\xff\xd8\xffbytes'}
                with self.assertRaises(type(cause)) as failure:
                    adapter.upload_one(page, upload, payload)
                self.assertIs(failure.exception, cause)
                upload.assert_called_once_with(page, payload, 'MK banner', single_delivery=True)
                token = page.evaluate.call_args_list[0].args[1]
                self.assertEqual(page.evaluate.call_args.args, ('(token) => abortMKImageUpload(token)', token))
                if where != 'delivery':
                    page.wait_for_function.assert_called_once_with(
                        '(token) => pollMKImageUpload(token).ready', arg=token, timeout=30000, polling=250)
                previous_calls = page.mock_calls[:]
                with self.assertRaisesRegex(stage3.ImagePublishError, 'no second file delivery'):
                    adapter.upload_one(page, upload, payload)
                self.assertEqual(page.mock_calls, previous_calls)
                self.assertEqual(upload.call_count, 1)
                self.assertFalse(adapter.submitted)
                self.assertEqual(adapter.rows, [])

    def test_phase_order_mandatory_arguments_and_operation_local_sha_receipts(self):
        adapter, page = self.uploaded()
        adapter.before_submit(page)
        self.trace.append('publish')
        adapter.confirm_publication('https://blog.example/100', '100')
        fetch = Mock(return_value=page.snapshot)
        adapter.public_gate(fetch)
        self.assertEqual(self.trace, ['draft'] + ['upload'] * 5 + ['editor', '--audit-banner', 'publish', 'public', '--audit-banner'])
        for command in self.commands:
            self.assertEqual(command[0], sys.executable)
            if command[2] == '--audit-banner':
                continue
            for flag, key in (('--body-file', 'body'), ('--image-input', 'current'),
                              ('--image-run-dir', 'run_dir'), ('--source-evidence-file', 'sources')):
                self.assertEqual(command[command.index(flag) + 1], str(self.options[key]))
            if command[2] != 'draft':
                self.assertIn('--snapshot-file', command)
                self.assertIn('--upload-receipt', command)
            if command[2] == 'public':
                self.assertEqual(command[command.index('--post-url') + 1], 'https://blog.example/100')
        for payload, row, src in zip(page.uploads, adapter.rows, page.srcs):
            self.assertEqual(row['file_sha256'], stage3.digest(payload['buffer']))
            self.assertEqual(row['uploaded_src'], src)
            self.assertEqual(payload['mimeType'], 'image/jpeg')
        self.assertEqual(len(adapter.rows), 4)
        self.assertNotIn(adapter.banner_src, [r['uploaded_src'] for r in adapter.rows])

    def test_draft_and_editor_failure_prevent_publish_despite_legacy_environment(self):
        self.reject = 'draft'
        with patch.dict(os.environ, TISTORY_OG_MATCH_GATE='0', ALLOW_MISSING_IMAGES='1'):
            with self.assertRaises(stage3.ImagePublishError):
                stage3.MKArticleImages(**self.options)
        self.assertEqual(self.trace, ['draft'])
        self.reject = None
        self.trace.clear()
        adapter, page = self.uploaded()
        self.reject = 'editor'
        publish = Mock()
        with self.assertRaises(stage3.ImagePublishError):
            adapter.before_submit(page)
            publish()
        publish.assert_not_called()
        self.assertFalse(adapter.submitted)

    def test_public_failure_preserves_identity_and_no_retry_or_second_submit(self):
        adapter, page = self.uploaded()
        adapter.before_submit(page)
        adapter.confirm_publication('https://blog.example/101', '101')
        self.reject = 'public'
        fetch = Mock(return_value=page.snapshot)
        with self.assertRaises(stage3.ImagePublishError):
            adapter.public_gate(fetch)
        failure = adapter.failure()
        fetch.assert_called_once()
        self.assertFalse(failure['success'])
        self.assertEqual(failure['postUrl'], 'https://blog.example/101')
        self.assertEqual(failure['postId'], '101')
        with self.assertRaises(stage3.ImagePublishError):
            adapter.before_submit(page)
        with self.assertRaises(stage3.ImagePublishError):
            stage3.MKArticleImages(**self.options)
        self.assertEqual(self.trace.count('public'), 1)

    def test_source_changed_during_upload_rejects_operation_without_receipt(self):
        adapter = stage3.MKArticleImages(**self.options)
        page = FakeEditor(self.bundle)
        entry = adapter.plan['articles'][0]
        output = adapter.run_dir / entry['filename']
        before = output.read_bytes()
        def tampered(*args, **kwargs):
            page.upload(*args, **kwargs)
            output.write_bytes(b'tampered')
        with self.assertRaisesRegex(stage3.ImagePublishError, 'binding changed'):
            adapter.upload_articles(page, tampered)
        self.assertEqual(page.uploads[0]['buffer'], before)
        self.assertEqual(adapter.rows, [])
        self.assertFalse((adapter.evidence / 'upload-receipt.json').exists())

    def test_banner_reusing_article_file_rejected_before_editor_side_effects(self):
        article = self.bundle['run'] / self.bundle['plan']['articles'][0]['filename']
        with self.assertRaisesRegex(stage3.ImagePublishError, 'banner reuses article bytes'):
            stage3.MKArticleImages(**dict(self.options, banner=article))
        self.assertEqual(self.trace, ['draft'])
        self.assertFalse(self.options['evidence_dir'].exists())

    def test_duplicate_operation_src_is_rejected_without_filename_fallback(self):
        adapter = stage3.MKArticleImages(**self.options)
        page = FakeEditor(self.bundle)
        page.return_src = 'https://cdn.example/reused.jpg'
        with self.assertRaisesRegex(stage3.ImagePublishError, 'duplicate upload'):
            adapter.upload_articles(page, page.upload)
        self.assertEqual(len(adapter.rows), 1)
        self.assertFalse(adapter.submitted)

    def test_draft_rejection_keeps_bounded_stdout_and_stderr_without_reserving_evidence(self):
        def reject(args, **kwargs):
            return subprocess.CompletedProcess(args, 1, json.dumps({'success': False, 'items': ['x' * 3000],
                                                                   'errors': ['source title mismatch']}),
                                               'validator: invalid source evidence')
        with self.assertRaises(stage3.ImagePublishError) as failure:
            stage3.MKArticleImages(**dict(self.options, runner=reject))
        self.assertIn('source title mismatch', str(failure.exception))
        self.assertIn('invalid source evidence', str(failure.exception))
        self.assertFalse(self.options['evidence_dir'].exists())

    def test_actual_constructor_failure_reports_distinct_reasons_before_browser(self):
        tree = embedded()
        constructor = next(n for n in tree.body if isinstance(n, ast.Try)
                           and any(isinstance(c, ast.Call) and ast.unparse(c.func) == 'MKArticleImages'
                                   for c in ast.walk(n)))
        blank = {key: '' for key in ('current', 'run_dir', 'validator', 'interpreter', 'sources', 'evidence_dir')}
        cases = [(dict(self.options, current=''), 'complete image flags'),
                 (dict(self.options, current=self.tmp / 'missing.json'), 'input file unavailable'),
                 (dict(self.options, enabled=False, **blank), 'image marker draft requires'),
                 (dict(self.options, runner=lambda *a, **k: subprocess.CompletedProcess(
                     a, 1, '{"success":false,"error":"source title mismatch"}',
                     'source unavailable; TOKEN="two word secret"')), 'source title mismatch')]
        body = self.options['body']
        original = body.read_text()
        for options, reason in cases:
            with self.subTest(reason=reason):
                body.write_text('<p data-article-id="mk"/>' if not options['enabled'] else original)
                def fail(message):
                    raise stage3.ImagePublishError(message)
                ns = dict(MKArticleImages=lambda **ignored: stage3.MKArticleImages(**options),
                          sys=SimpleNamespace(argv=[''] * 23), TEMPLATE='mk-review', PRIVATE=False,
                          BODY_FILE=str(body), BANNER=str(self.options['banner']), BANNER_ALT='banner', os=os,
                          fail=fail, bounded_diagnostic=stage3.bounded_diagnostic)
                browser_entry = Mock()
                with self.assertRaises(stage3.ImagePublishError) as failure:
                    exec(compile(ast.Module(body=[constructor], type_ignores=[]), 'constructor', 'exec'), ns)
                    browser_entry()
                self.assertIn('mk-images/draft-preflight-failed:', str(failure.exception))
                self.assertIn(reason, str(failure.exception))
                self.assertNotIn('two word secret', str(failure.exception))
                browser_entry.assert_not_called()
                self.assertFalse(self.options['evidence_dir'].exists())
        body.write_text(original)

    def test_diagnostics_are_bounded_and_redact_credentials_in_both_streams(self):
        with patch.dict(os.environ, TEST_API_KEY='env-credential-value'):
            text = stage3.bounded_diagnostic('mismatch env-credential-value password="two word secret" '
                                             'https://user:pass@example.test/path Bearer raw-auth\n' + 'x' * 5000)
        for secret in ('env-credential-value', 'two word secret', 'user:pass', 'raw-auth'):
            self.assertNotIn(secret, text)
        self.assertIn('mismatch', text)
        self.assertIn('[truncated]', text)
        self.assertLessEqual(len(text), 1820)
        for stdout, stderr, reason in (('unparsed', 'decode failed', 'structured success'),
                                        ('x' * 140000, 'too large', 'oversized'),
                                        ('[]', 'wrong shape', 'object required')):
            def runner(*args, **kwargs):
                return subprocess.CompletedProcess(args, 1, stdout, stderr)
            with self.subTest(reason=reason), self.assertRaises(stage3.ImagePublishError) as failure:
                stage3.MKArticleImages(**dict(self.options, runner=runner))
            self.assertIn(reason, str(failure.exception))
            self.assertIn(stderr, str(failure.exception))
            self.assertLess(len(str(failure.exception)), 1500)

    def test_actual_og_command_uses_image_context_and_public_snapshot(self):
        adapter, page = self.uploaded()
        process = Mock()
        process.run.return_value = subprocess.CompletedProcess([], 0, '{"success":true,"count":4,"card_count":4}', '')
        ns = og_namespace(adapter, process)
        ns['run_og_gate']('draft')
        draft = process.run.call_args.args[0]
        self.assertEqual(draft[:3], [str(adapter.interpreter), str(adapter.validator), 'draft'])
        for flag, value in (('--image-input', adapter.current), ('--image-run-dir', adapter.run_dir),
                            ('--source-evidence-file', adapter.sources)):
            self.assertEqual(draft[draft.index(flag) + 1], str(value))
        adapter.before_submit(page)
        adapter.confirm_publication('https://blog.example/345', '345')
        adapter.public_gate(Mock(return_value=page.snapshot))
        ns['run_og_gate']('public', adapter.post_url)
        public = process.run.call_args.args[0]
        self.assertEqual(public[public.index('--snapshot-file') + 1], str(adapter.evidence / 'public.html'))
        self.assertEqual(public[public.index('--upload-receipt') + 1], str(adapter.evidence / 'upload-receipt.json'))

    def test_actual_strict_og_failure_retains_publication_identity_and_nonzero_exit(self):
        adapter, page = self.uploaded()
        adapter.before_submit(page)
        adapter.confirm_publication('https://blog.example/345', '345')
        adapter.public_gate(Mock(return_value=page.snapshot))
        process = Mock()
        ns = og_namespace(adapter, process)
        for code, stdout in ((1, '{"success":true}'), (1, '{"success":false}'), (0, '{"success":false}'),
                             (0, 'not JSON'), (0, '[]'), (0, '{"success":1}'), (0, '{}'), (0, ''),
                             (0, 'progress\nnull\n'), (0, 'progress\n{"success":true}\nwarning after JSON'),
                             (0, 'progress\n{"success":false}\n'), (0, 'x' * 131073)):
            process.run.return_value = subprocess.CompletedProcess([], code, stdout, 'OG mismatch')
            with self.subTest(code=code, stdout=stdout), patch('builtins.print') as output, self.assertRaises(SystemExit) as exit_code:
                ns['run_og_gate']('public', adapter.post_url)
            self.assertEqual(exit_code.exception.code, 1)
            result = json.loads(output.call_args.args[0])
            self.assertEqual(result['phase'], 'public')
            self.assertEqual(result['postUrl'], 'https://blog.example/345')
            self.assertEqual(result['postId'], '345')
            self.assertTrue(result['submitted'])
            self.assertFalse(result['success'])
            self.assertFalse(result['automaticRetryAllowed'])
            self.assertIn('OG public', result['detail'])
            self.assertLessEqual(len(result['detail']), 520)
            self.assertEqual(json.loads((adapter.evidence / 'state.json').read_text())['status'], 'failed')

    def test_actual_og_accepts_last_nonempty_json_line_but_stage2_remains_whole_stdout(self):
        adapter, page = self.uploaded()
        process = Mock()
        proof = {'success': True, 'count': 4, 'card_count': 4}
        process.run.return_value = subprocess.CompletedProcess([], 0, 'progress\nwarning\n' + json.dumps(proof) + '\n \n', '')
        ns = og_namespace(adapter, process)
        for mode in ('draft', 'public'):
            with self.subTest(mode=mode):
                self.assertEqual(ns['run_og_gate'](mode, 'https://blog.example/345'), proof)
        adapter.runner = process.run
        with self.assertRaisesRegex(stage3.ImagePublishError, 'structured success'):
            adapter.invoke(['explicit-stage2-validator'])

    def test_only_stage1_jpeg_contract_is_accepted_before_evidence_or_upload(self):
        manifest = self.bundle['run'] / 'manifest.json'
        original = json.loads(manifest.read_text())
        for name, content in (('asset.png', b'\x89PNG\r\n\x1a\nPNG bytes'),
                              ('asset.jpg', b'\x89PNG\r\n\x1a\nPNG bytes'),
                              ('asset.unknown', b'\xff\xd8\xffJPEG bytes')):
            with self.subTest(name=name):
                state = copy.deepcopy(original)
                state['plan']['articles'][0]['filename'] = name
                (self.bundle['run'] / name).write_bytes(content)
                state['assets'][0]['sha256'] = stage3.digest(content)
                save(manifest, state)
                with self.assertRaisesRegex(stage3.ImagePublishError, 'JPEG'):
                    stage3.MKArticleImages(**self.options)
                self.assertFalse(self.options['evidence_dir'].exists())


@unittest.skipUnless(os.environ.get('MK_STAGE2_DIR'), 'set MK_STAGE2_DIR for external Stage2 integration')
class RealStage2Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tmp = Path(self.temp.name)
        self.directory = Path(os.environ['MK_STAGE2_DIR'])
        self.python = os.environ.get('MK_STAGE2_PYTHON', sys.executable)
        # Blocks even accidental network use inside the separate validator process.
        guard = self.tmp / 'offline'
        guard.mkdir()
        (guard / 'sitecustomize.py').write_text('import socket\ndef forbidden(*a, **k):\n raise AssertionError("offline test: network forbidden")\nsocket.create_connection=forbidden\nsocket.socket.connect=forbidden\n')
        import PIL
        # Homebrew's sitecustomize normally adds this dependency directory; our
        # offline sitecustomize must retain it explicitly for the child process.
        deps = str(Path(PIL.__file__).resolve().parent.parent)
        self.env = patch.dict(os.environ, PYTHONPATH=str(guard) + os.pathsep + deps, PYTHONDONTWRITEBYTECODE='1')
        self.env.start()
        self.addCleanup(self.env.stop)
        self.bundle = make_bundle(self.tmp, self.directory)
        self.options = dict(enabled=True, template='mk-review', private=False, body=self.bundle['run'] / 'body.html',
            current=self.tmp / 'current.json', run_dir=self.bundle['run'], validator=self.directory / 'validate-og.py',
            interpreter=self.python, sources=self.tmp / 'sources.json', evidence_dir=self.tmp / 'evidence',
            banner=self.bundle['banner'], banner_alt='독립 배너')

    def adapter(self, **overrides):
        return stage3.MKArticleImages(**dict(self.options, **overrides))

    def uploaded(self):
        adapter = self.adapter()
        editor = FakeEditor(self.bundle)
        adapter.upload_articles(editor, editor.upload)
        adapter.upload_banner(editor, editor.upload)
        editor.snapshot = render_editor(self.bundle, editor)
        return adapter, editor

    def test_real_validator_all_phases_receipt_bytes_and_separate_banner(self):
        adapter, editor = self.uploaded()
        for entry, payload, row in zip(self.bundle['plan']['articles'], editor.uploads, adapter.rows):
            self.assertEqual(stage3.digest(payload['buffer']), row['file_sha256'])
            self.assertEqual(payload['buffer'], (self.bundle['run'] / entry['filename']).read_bytes())
            self.assertEqual(row['uploaded_src'], editor.srcs[entry['index'] - 1])
        receipt = json.loads((adapter.evidence / 'upload-receipt.json').read_text())
        self.assertEqual(len(receipt['articles']), 4)
        self.assertNotIn(editor.srcs[4], json.dumps(receipt))
        adapter.before_submit(editor)
        adapter.confirm_publication('https://blog.example/123', '123')
        fetch = Mock(return_value='<html><body><div class="contents_style">' + editor.snapshot + '</div></body></html>')
        self.assertTrue(adapter.public_gate(fetch)['success'])
        fetch.assert_called_once_with('https://blog.example/123')
        self.assertEqual(json.loads((adapter.evidence / 'state.json').read_text())['status'], 'verified')
        for file in adapter.evidence.iterdir():
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(adapter.evidence.stat().st_mode & 0o777, 0o700)

    def test_real_configured_og_gates_use_full_image_contract_without_fetch(self):
        adapter, editor = self.uploaded()
        ns = og_namespace(adapter, subprocess)
        self.assertTrue(ns['run_og_gate']('draft')['success'])
        adapter.before_submit(editor)
        adapter.confirm_publication('https://blog.example/124', '124')
        adapter.public_gate(Mock(return_value='<div class="contents_style">' + editor.snapshot + '</div>'))
        proof = ns['run_og_gate']('public', adapter.post_url)
        self.assertTrue(proof['success'])
        self.assertEqual(proof['card_count'], 4)
        self.assertEqual(proof['images']['verified'], 4)

    def test_editor_rejects_structural_and_identity_mistakes_before_submit(self):
        adapter, editor = self.uploaded()
        original = editor.snapshot
        entries = self.bundle['plan']['articles']
        src1, src2 = editor.srcs[:2]
        variants = {
            'wrong-src': original.replace(src1, 'https://cdn.example/wrong.jpg'),
            'duplicate': original.replace(src2, src1),
            'swapped': original.replace(src1, 'TEMP').replace(src2, src1).replace('TEMP', src2),
            'missing': re.sub(r'<figure data-ke-type="image"><img src="' + re.escape(src1) + r'".*?</figure>', '', original),
            'extra': original + '<figure data-ke-type="image"><img src="https://cdn.example/extra.jpg"></figure>',
            'wrong-alt': original.replace(escape(entries[0]['alt']), 'wrong alt'),
            'wrong-caption': original.replace(escape(entries[0]['caption']), 'wrong AI disclosure', 1),
            'card-source': original.replace('data-og-source-url="' + entries[0]['source_url'], 'data-og-source-url="https://www.mk.co.kr/news/economy/1'),
            'card-canonical': original.replace('data-og-url="' + entries[0]['source_url'], 'data-og-url="https://www.mk.co.kr/news/economy/2'),
            'card-title': original.replace('data-og-title="' + escape(entries[0]['title']), 'data-og-title="완전히 다른 소식'),
            'card-thumbnail-unknown': original.replace('data-og-image="https://og.example/0.jpg"', ''),
            'wrong-heading-order': original.replace('① ' + entries[0]['title'], '② ' + entries[1]['title']),
            'missing-banner': re.sub(r'^<figure.*?</figure>', '', original),
            'extra-banner': original[:original.index('<h2')] + original,
            'wrong-banner': original.replace(editor.srcs[4], 'https://cdn.example/wrong-banner.jpg'),
            'banner-article-reuse': original.replace(editor.srcs[4], src1),
            'non-image-embed': original.replace('</a></figure>', '<iframe></iframe></a></figure>', 1),
        }
        for label, html in variants.items():
            with self.subTest(label=label):
                editor.snapshot = html
                with self.assertRaises(stage3.ImagePublishError):
                    adapter.before_submit(editor)
                self.assertFalse(adapter.submitted)
        editor.snapshot = original
        adapter.before_submit(editor)
        self.assertTrue(adapter.submitted)

    def test_public_failure_retains_publication_identity_and_never_retries(self):
        adapter, editor = self.uploaded()
        adapter.before_submit(editor)
        adapter.confirm_publication('https://blog.example/321', '321')
        fetch = Mock(return_value=editor.snapshot.replace(editor.srcs[0], 'https://cdn.example/tampered.jpg'))
        with patch.dict(os.environ, ALLOW_MISSING_IMAGES='1', TISTORY_OG_MATCH_GATE='0'):
            with self.assertRaises(stage3.ImagePublishError):
                adapter.public_gate(fetch)
        failure = adapter.failure()
        self.assertFalse(failure['success'])
        self.assertEqual(failure['postUrl'], 'https://blog.example/321')
        self.assertEqual(failure['postId'], '321')
        self.assertFalse(failure['automaticRetryAllowed'])
        fetch.assert_called_once()
        self.assertEqual(len(editor.uploads), 5)
        with self.assertRaisesRegex(stage3.ImagePublishError, 'already exists'):
            self.adapter()
        self.assertEqual(json.loads((adapter.evidence / 'state.json').read_text())['postId'], '321')

    def test_source_and_evidence_changes_fail_across_phases(self):
        adapter, editor = self.uploaded()
        paths = [self.tmp / 'current.json', self.tmp / 'sources.json', self.bundle['run'] / 'body.html',
                 self.bundle['run'] / 'manifest.json', self.bundle['banner'],
                 self.bundle['run'] / self.bundle['plan']['articles'][0]['filename'],
                 self.tmp / 'identity-only-engine.py']
        for path in paths:
            before = path.read_bytes()
            path.write_bytes(before + b' ')
            with self.subTest(path=path.name), self.assertRaises(stage3.ImagePublishError):
                adapter.before_submit(editor)
            path.write_bytes(before)
        receipt = adapter.evidence / 'upload-receipt.json'
        value = json.loads(receipt.read_text())
        value['articles'][0]['uploaded_src'] = 'https://cdn.example/forged.jpg'
        save(receipt, value)
        with self.assertRaisesRegex(stage3.ImagePublishError, 'evidence changed'):
            adapter.before_submit(editor)
        self.assertFalse(adapter.submitted)

    def test_draft_bad_current_input_or_sources_no_upload_or_cdp(self):
        data = copy.deepcopy(self.bundle['data'])
        data['articles'].reverse()
        save(self.tmp / 'current.json', data)
        with self.assertRaises(stage3.ImagePublishError):
            self.adapter()
        self.assertFalse((self.tmp / 'evidence').exists())
        save(self.tmp / 'current.json', self.bundle['data'])
        save(self.tmp / 'sources.json', {})
        with self.assertRaises(stage3.ImagePublishError):
            self.adapter()

    def test_receipt_reorder_missing_extra_duplicate_and_wrong_sha_rejected_by_stage2(self):
        adapter, editor = self.uploaded()
        snapshot = adapter.write('editor.html', editor.snapshot)
        receipt_path = adapter.evidence / 'upload-receipt.json'
        original = json.loads(receipt_path.read_text())
        variants = {}
        value = copy.deepcopy(original); value['articles'].reverse(); variants['reorder'] = value
        value = copy.deepcopy(original); value['articles'].pop(); variants['missing'] = value
        value = copy.deepcopy(original); value['articles'].append(value['articles'][0]); variants['extra'] = value
        value = copy.deepcopy(original); value['articles'][1]['uploaded_src'] = value['articles'][0]['uploaded_src']; variants['duplicate-src'] = value
        value = copy.deepcopy(original); value['articles'][0]['file_sha256'] = '0' * 64; variants['wrong-sha'] = value
        for label, value in variants.items():
            save(receipt_path, value)
            with self.subTest(label=label), self.assertRaises(stage3.ImagePublishError):
                adapter.gate('editor', snapshot)
        self.assertFalse(adapter.submitted)

    def test_real_embedded_preflight_precedes_even_mock_browser_entry_and_ignores_gate_off(self):
        guard = self.tmp / 'offline'
        package = guard / 'playwright'
        package.mkdir()
        (package / '__init__.py').write_text('')
        (package / 'sync_api.py').write_text(
            'import os\nfrom pathlib import Path\nTimeoutError=TimeoutError\n'
            'class Stop:\n def __enter__(self):\n'
            '  Path(os.environ["MK_TEST_ENTERED"]).write_text("mock browser entered")\n'
            '  raise RuntimeError("STOP: browser is mocked")\n'
            ' def __exit__(self, *a): return False\n'
            'def sync_playwright(): return Stop()\n')
        entered = self.tmp / 'browser-entry'
        # Execute the actual heredoc directly: the sandbox blocks Bash's
        # /dev/fd tee redirection, so no shell/process-substitution is needed.
        source = re.search(r"<< 'PYTHON_SCRIPT'\n(.*?)\nPYTHON_SCRIPT\n",
                           (SCRIPTS / 'publish-post.sh').read_text(), re.S)[1]
        args = [sys.executable, '-', '18800', 'blog.example', 'offline title', str(self.options['body']),
                'offline category', '', str(self.options['banner']), str(SCRIPTS / 'tistory-editor-helpers.js'),
                'false', '0', 'mk-review', '독립 배너', str(SCRIPTS), '15000', 'true',
                str(self.options['current']), str(self.options['run_dir']), str(self.options['validator']),
                str(self.options['interpreter']), str(self.options['sources']), str(self.options['evidence_dir']), '']
        env = dict(os.environ, ALLOW_DIRECT_TISTORY_PUBLISH='1', TISTORY_OG_MATCH_GATE='0',
                   ALLOW_MISSING_IMAGES='1', TISTORY_PUBLISH_LOCK='0', MK_TEST_ENTERED=str(entered))
        current = self.tmp / 'current.json'
        data = copy.deepcopy(self.bundle['data']); data['articles'].reverse(); save(current, data)
        result = subprocess.run(args, input=source, text=True, capture_output=True, env=env, timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(entered.exists(), result.stderr)
        self.assertIn('mk-images/draft-preflight-failed', result.stdout, result.stderr)
        save(current, self.bundle['data'])
        result = subprocess.run(args, input=source, text=True, capture_output=True, env=env, timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(entered.exists(), result.stderr)
        self.assertIn('mk-images/draft-failed', result.stdout)

    def test_upload_result_must_be_unique_https_operation_response(self):
        adapter = self.adapter()
        editor = FakeEditor(self.bundle)
        editor.return_src = 'blob:pending'
        with self.assertRaises(stage3.ImagePublishError):
            adapter.upload_articles(editor, editor.upload)
        self.assertEqual(adapter.rows, [])


if __name__ == '__main__':
    unittest.main()
