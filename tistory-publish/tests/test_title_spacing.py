import ast
import html
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import warnings
from xml.sax.saxutils import escape


SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
SPEC = importlib.util.spec_from_file_location('title_spacing', SCRIPTS / 'title_spacing.py')
SPACING = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SPACING)


def embedded_tree(script='publish-post.sh'):
    source = (SCRIPTS / script).read_text(encoding='utf-8')
    code = re.search(r"<< 'PYTHON_SCRIPT'\n(.*?)\nPYTHON_SCRIPT\n", source, re.S).group(1)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', SyntaxWarning)
        return ast.parse(code)


def execute_nodes(nodes, namespace):
    exec(compile(ast.Module(body=nodes, type_ignores=[]), '<publisher>', 'exec'), namespace)


def import_spacing_helper(tree, namespace):
    imports = [n for n in tree.body if isinstance(n, ast.ImportFrom) and n.module == 'title_spacing']
    assert len(imports) == 1
    with patch.dict(sys.modules, title_spacing=SPACING):
        execute_nodes(imports, namespace)


class TitleSpacingTests(unittest.TestCase):
    def test_exact_spacing_edges_runs_and_idempotence(self):
        cases = {
            '수사 요청·시대인재': '수사 요청 · 시대인재',
            '가 ·나· 다': '가 · 나 · 다',
            '가\t\n·\u00a0\u2003나': '가 · 나',
            '가·· ·\t나': '가 · · · 나',
            '·시작': ' · 시작',
            '끝·': '끝 · ',
            '\t··\n': ' · · ',
            '': '',
            ' · ': ' · ',
        }
        for original, expected in cases.items():
            with self.subTest(original=original):
                actual = SPACING.normalize_title_spacing(original)
                self.assertEqual(actual, expected)
                self.assertEqual(SPACING.normalize_title_spacing(actual), expected)
                self.assertEqual(actual.count('·'), original.count('·'))

    def test_other_text_punctuation_and_unrelated_whitespace_are_unchanged(self):
        unchanged = '\n  가ㆍ나・다‧라•마.바…사—아/자 &middot; &#183; "인용"\t\n'
        self.assertEqual(SPACING.normalize_title_spacing(unchanged), unchanged)
        self.assertEqual(SPACING.normalize_title_spacing('\n  가  나·다  라\t\n'),
                         '\n  가  나 · 다  라\t\n')


class EntrypointTests(unittest.TestCase):
    def run_shell_prefix(self, script, title, article=False, explicit_alt=False):
        # Execute the real argument/preset/normalization/SEO wiring, stopping
        # before the browser program. Only the SEO consumer is replaced.
        prefix = (SCRIPTS / script).read_text(encoding='utf-8').split('# ── 메인: Python Playwright CDP ──')[0]
        seo_probe = '''
python3() {
  if [[ "$1" == */seo_check.py ]]; then
    command python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@"
  else
    command python3 "$@"
  fi
}
'''
        probe = '''
command python3 - "$TITLE" "$BANNER_ALT" "$TAGS" <<'PROBE'
import json, sys
print(json.dumps(sys.argv[1:]))
PROBE
'''
        with tempfile.TemporaryDirectory() as temp:
            body = Path(temp) / 'body.html'
            original_body = '<h2>본문·제목</h2><p data-og-placeholder="https://example.test/a·b?q=c·d">출처·설명</p>'
            body.write_text(original_body, encoding='utf-8')
            banner = Path(temp) / 'banner.jpg'
            banner.write_bytes(b'offline fixture')
            args = ['--body-file', str(body), '--banner', str(banner), '--category', 'offline',
                    '--blog', 'example.test', '--seo-check', 'warn', '--tags', '태그·원문']
            if article:
                args += ['--template', 'mk-review', '--article-title', title]
            else:
                args += ['--title', title]
            if explicit_alt:
                args += ['--banner-alt', '명시·alt']
            env = {'PATH': os.environ['PATH'], 'ALLOW_DIRECT_TISTORY_PUBLISH': '1',
                   'PYTHONDONTWRITEBYTECODE': '1'}
            result = subprocess.run(['bash', '-c', seo_probe + prefix + probe, str(SCRIPTS / script)] + args,
                                    env=env, text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            seo, values = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(seo[seo.index('--title') + 1], values[0])
            self.assertEqual(body.read_text(encoding='utf-8'), original_body)
            self.assertEqual(values[2], '태그·원문')
            return values

    def assert_editor_title(self, script, title):
        tree = embedded_tree(script)
        page = Mock()
        ns = {'sys': SimpleNamespace(argv=['-', '18800', 'example.test', title]),
              'page': page, 'json': json, 'RUN_TOKEN': ''}
        if script == 'publish-post.sh':
            import_spacing_helper(tree, ns)
        title_assignment = next(n for n in tree.body if isinstance(n, ast.Assign)
                                and any(isinstance(t, ast.Name) and t.id == 'TITLE' for t in n.targets))
        execute_nodes([title_assignment], ns)
        if script == 'publish-post.sh':
            final = next(n for n in ast.walk(tree) if isinstance(n, ast.Assign)
                         and any(isinstance(t, ast.Name) and t.id == 'final_title' for t in n.targets))
            execute_nodes([final], ns)
        editor = next(n for n in ast.walk(tree) if isinstance(n, ast.Expr)
                      and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Attribute)
                      and n.value.func.attr == 'evaluate' and 't.textContent =' in ast.unparse(n))
        execute_nodes([editor], ns)
        self.assertIn('t.textContent = ' + json.dumps(title) + ';', page.evaluate.call_args.args[0])
        if script == 'publish-post.sh':
            for consumer in ('assert_no_duplicate_title_before_publish', 'confirm_public_publish', 'find_latest_post'):
                calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
                         and isinstance(n.func, ast.Name) and n.func.id == consumer]
                self.assertTrue(any(isinstance(n.args[1], ast.Name) and n.args[1].id == 'final_title'
                                    for n in calls), consumer)

    def test_both_entrypoints_direct_and_article_preset_before_seo_and_editor(self):
        for script in ('publish-post.sh', 'publish.sh'):
            for article in (False, True):
                with self.subTest(script=script, article=article):
                    values = self.run_shell_prefix(script, '수사 요청·시대인재', article)
                    expected = '수사 요청 · 시대인재'
                    if article:
                        self.assertRegex(values[0], r'^\[매경\] \d{4}\.\d{2}\.\d{2}\([월화수목금토일]\) - ' + expected + '$')
                    else:
                        self.assertEqual(values[0], expected)
                    self.assertEqual(values[1], values[0])
                    self.assert_editor_title(script, values[0])

    def test_shell_preserves_edge_spaces_newlines_and_explicit_alt(self):
        for script in ('publish-post.sh', 'publish.sh'):
            values = self.run_shell_prefix(script, '\n  ·가··나·', explicit_alt=True)
            self.assertEqual(values[:2], [' · 가 · · 나 · ', '명시·alt'])
            values = self.run_shell_prefix(script, '  가·나\t\n')
            self.assertEqual(values[0], '  가 · 나\t\n')


class DuplicateGuardTests(unittest.TestCase):
    def setUp(self):
        names = {'norm_title', 'same_title', 'mk_review_date_prefix', 'same_mk_review_date',
                 'find_public_post_by_rss', 'find_manage_post_by_title',
                 'assert_no_duplicate_title_before_publish', 'find_latest_post'}
        self.ns = {'re': re, 'htmlmod': html,
                   'BLOG': 'example.test', 'TEMPLATE': '', 'POSTS_URL': 'https://example.test/manage/posts/',
                   'log': Mock(), 'fail': Mock(side_effect=RuntimeError('duplicate blocked'))}
        tree = embedded_tree()
        import_spacing_helper(tree, self.ns)
        execute_nodes([n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names], self.ns)
        self.page = Mock()
        self.context = Mock()
        self.context.new_page.return_value = self.page

    def test_historical_entities_quotes_and_whitespace_still_compare(self):
        same = self.ns['same_title']
        # Preserve the existing order of whitespace cleanup and quote removal.
        self.assertEqual(self.ns['norm_title'](' " 제목 " '), ' 제목 ')
        for historic in ('수사 요청·시대인재', '수사 요청 &middot; 시대인재',
                         '“수사 요청”\t&#183;\u00a0시대인재'):
            self.assertTrue(same(historic, '수사 요청 · 시대인재'))
        for different in ('수사 요청 시대인재', '수사 요청ㆍ시대인재', '수사 요청··시대인재', '다른 요청·시대인재'):
            self.assertFalse(same(different, '수사 요청 · 시대인재'))

    def test_rss_and_manage_each_block_historical_title_and_confirmation_matches(self):
        historic = '수사 요청·시대인재'
        post = {'href': 'https://example.test/123', 'text': historic}
        rss = ('<rss><channel><item><title>' + escape(historic)
               + '</title><link>https://example.test/123</link></item></channel></rss>').encode()
        for source in ('rss', 'manage'):
            with self.subTest(source=source):
                clock = Mock()
                clock.time.side_effect = [0, 0, 5]  # one offline RSS iteration
                self.ns.update(time=clock, list_recent_posts=Mock(return_value=[post]))
                payload = rss if source == 'rss' else b'<rss><channel/></rss>'
                with patch('urllib.request.urlopen', return_value=io.BytesIO(payload)):
                    with self.assertRaisesRegex(RuntimeError, 'duplicate blocked'):
                        self.ns['assert_no_duplicate_title_before_publish'](self.context, '수사 요청 · 시대인재')
                if source == 'manage':
                    self.page.close.assert_called_once()
        self.ns['time'] = SimpleNamespace(time=lambda: 0)
        confirmed = self.ns['find_latest_post'](self.page, '수사 요청 · 시대인재')
        self.assertEqual(confirmed['id'], '123')

    def test_mk_same_date_guard_is_preserved(self):
        self.ns['TEMPLATE'] = 'mk-review'
        self.assertTrue(self.ns['same_mk_review_date']('[매경] 2026.11.18(수) - 과거·제목',
                                                     '[매경] 2026.11.18(수) - 새 제목'))
        self.assertFalse(self.ns['same_mk_review_date']('[매경] 2026.11.17(화) - 과거·제목',
                                                      '[매경] 2026.11.18(수) - 새 제목'))


if __name__ == '__main__':
    unittest.main()
