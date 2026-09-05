import ast
import re
import unittest
import warnings
from pathlib import Path
from urllib.parse import urlsplit


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "publish-post.sh"
FUNCTION_NAMES = {
    "daum_trends_management_page_kind",
    "select_daum_trends_management_pages_to_close",
    "cleanup_daum_trends_management_pages",
}
CLASS_NAME = "DaumTrendsTabCleanup"
BLOG = "trends.example.tistory.com"


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
        if (
            isinstance(node, ast.FunctionDef)
            and node.name in FUNCTION_NAMES
        ) or (
            isinstance(node, ast.ClassDef)
            and node.name == CLASS_NAME
        )
    ]
    found_functions = {node.name for node in selected if isinstance(node, ast.FunctionDef)}
    found_classes = {node.name for node in selected if isinstance(node, ast.ClassDef)}
    if found_functions != FUNCTION_NAMES or found_classes != {CLASS_NAME}:
        raise AssertionError("Daum Trends tab cleanup helpers not found in embedded Python")

    logs = []
    namespace = {"re": re, "urlsplit": urlsplit, "log": logs.append}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(SCRIPT_PATH), "exec"), namespace)
    namespace["logs"] = logs
    return namespace


class FakePage:
    def __init__(self, url):
        self.url = url
        self.closed = False

    def is_closed(self):
        return self.closed

    def close(self):
        self.closed = True


class FakeContext:
    def __init__(self, pages):
        self._pages = pages

    @property
    def pages(self):
        return [page for page in self._pages if not page.closed]


class FakeBrowser:
    def __init__(self, pages):
        self.contexts = [FakeContext(pages)]


class DaumTrendsTabCleanupTests(unittest.TestCase):
    def setUp(self):
        self.ns = load_cleanup_helpers()
        self.kind = self.ns["daum_trends_management_page_kind"]
        self.select = self.ns["select_daum_trends_management_pages_to_close"]
        self.cleanup = self.ns["cleanup_daum_trends_management_pages"]
        self.manager_type = self.ns[CLASS_NAME]

    def test_target_selection_is_limited_to_exact_same_blog_management_pages(self):
        self.assertEqual(self.kind(f"https://{BLOG}/manage/posts/", BLOG), "posts")
        self.assertEqual(
            self.kind(f"https://{BLOG}/manage/statistics/entry/12345", BLOG),
            "statistics-entry",
        )

        excluded = [
            f"https://{BLOG}/manage/newpost/?type=post",
            f"https://{BLOG}/manage/posts/?page=2",
            f"https://{BLOG}/manage/statistics/entry/12345?from=posts",
            f"https://{BLOG}/entry/public-post",
            f"https://other.example.tistory.com/manage/posts/",
            "https://accounts.kakao.com/login",
            "about:blank",
        ]
        for url in excluded:
            with self.subTest(url=url):
                self.assertIsNone(self.kind(url, BLOG))

    def test_selection_preserves_last_page_per_kind_and_protected_run_page(self):
        old_posts = FakePage(f"https://{BLOG}/manage/posts/")
        new_posts = FakePage(f"https://{BLOG}/manage/posts/")
        old_stats = FakePage(f"https://{BLOG}/manage/statistics/entry/100")
        new_stats = FakePage(f"https://{BLOG}/manage/statistics/entry/101")
        editor = FakePage(f"https://{BLOG}/manage/newpost/?type=post")
        login = FakePage("https://accounts.kakao.com/login")

        selected = self.select(
            [old_posts, old_stats, editor, new_posts, new_stats, login],
            BLOG,
        )
        self.assertEqual(selected, [old_posts, old_stats])

        selected_with_protection = self.select(
            [old_posts, old_stats, new_posts, new_stats],
            BLOG,
            protected_pages=[old_posts],
        )
        self.assertEqual(selected_with_protection, [new_posts, old_stats])

    def test_repeated_success_cleanup_does_not_accumulate_owned_pages(self):
        editor = FakePage(f"https://{BLOG}/manage/newpost/?type=post")
        login = FakePage("https://accounts.kakao.com/login")
        other_blog = FakePage("https://other.example.tistory.com/manage/posts/")
        pages = [editor, login, other_blog]
        browser = FakeBrowser(pages)

        for post_id in range(1, 4):
            current_posts = FakePage(f"https://{BLOG}/manage/posts/")
            current_stats = FakePage(f"https://{BLOG}/manage/statistics/entry/{post_id}")
            pages.extend([current_posts, current_stats])

            result = self.cleanup(
                browser,
                "daum-trends",
                BLOG,
                protected_pages=[current_posts],
                reason=f"run-{post_id}",
            )

            open_owned = [
                page
                for page in browser.contexts[0].pages
                if self.kind(page.url, BLOG)
            ]
            self.assertEqual(open_owned, [current_posts, current_stats])
            self.assertEqual(result["failed"], 0)

        self.assertFalse(editor.closed)
        self.assertFalse(login.closed)
        self.assertFalse(other_blog.closed)

    def test_failure_exit_cleans_duplicates_but_preserves_diagnostic_editor(self):
        old_posts = FakePage(f"https://{BLOG}/manage/posts/")
        old_stats = FakePage(f"https://{BLOG}/manage/statistics/entry/200")
        editor = FakePage(f"https://{BLOG}/manage/newpost/?type=post")
        pages = [old_posts, old_stats, editor]
        browser = FakeBrowser(pages)

        with self.assertRaisesRegex(RuntimeError, "publish failed"):
            with self.manager_type("daum-trends", BLOG) as manager:
                manager.attach(browser)
                manager.protect(editor)
                pages.extend([
                    FakePage(f"https://{BLOG}/manage/posts/"),
                    FakePage(f"https://{BLOG}/manage/statistics/entry/201"),
                ])
                raise RuntimeError("publish failed")

        self.assertTrue(old_posts.closed)
        self.assertTrue(old_stats.closed)
        self.assertFalse(editor.closed)
        self.assertEqual(len(browser.contexts[0].pages), 3)

    def test_other_templates_do_not_close_pages(self):
        pages = [
            FakePage(f"https://{BLOG}/manage/posts/"),
            FakePage(f"https://{BLOG}/manage/posts/"),
        ]
        result = self.cleanup(FakeBrowser(pages), "simple-post", BLOG)
        self.assertEqual(result, {"enabled": False, "closed": 0, "failed": 0})
        self.assertTrue(all(not page.closed for page in pages))


if __name__ == "__main__":
    unittest.main()
