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


class ContractTests(unittest.TestCase):
    def test_legacy_marker_guard_including_no_template_and_self_closing(self):
        for template in ('', 'mk-review', 'simple-post', 'daum-trends'):
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
        adapter.ready = False
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


class MKRepresentativeTests(unittest.TestCase):
    """Execute the real Step6 branch; no browser or publication is performed."""
    src = 'https://cdn.example/opaque-upload?signature=keep%2Fall&v=2'

    def run_step6(self, result=None, src=None, skip='', enabled=True, template='mk-review', error=None):
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
                  image_files=['01-trend.jpg'], resolve_represent_image_target=self.resolve,
                  submit=self.submit)
        # The sentinel stands for all later submit work and must remain untouched on failure.
        module = ast.Module(body=[helper, step, ast.parse('submit()').body[0]], type_ignores=[])
        exec(compile(module, 'actual-step6', 'exec'), ns)

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

    def wait_for_function(self, expression, *, arg, timeout):
        assert arg == self.token and timeout == 30000

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
            output = run / entry['filename']; output.write_bytes(b'mock bytes ' + bytes([i]))
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
