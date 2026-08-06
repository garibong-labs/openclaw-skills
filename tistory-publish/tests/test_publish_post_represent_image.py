import ast
import os
import re
import unittest
import warnings
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "publish-post.sh"
FUNCTION_NAME = "resolve_represent_image_target"


def load_resolver():
    shell_source = SCRIPT_PATH.read_text(encoding="utf-8")
    match = re.search(r"<< 'PYTHON_SCRIPT'\n(.*?)\nPYTHON_SCRIPT\n", shell_source, re.DOTALL)
    if not match:
        raise AssertionError("embedded Python publish script not found")

    # The embedded legacy script contains two unrelated invalid-escape warnings.
    # Keep this focused test quiet while still compiling the selected helper.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", SyntaxWarning)
        tree = ast.parse(match.group(1), filename=str(SCRIPT_PATH))
    selected = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == FUNCTION_NAME
    ]
    if len(selected) != 1:
        raise AssertionError(f"{FUNCTION_NAME} not found in embedded Python")

    namespace = {"re": re, "os": os}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(SCRIPT_PATH), "exec"), namespace)
    return namespace[FUNCTION_NAME]


class ResolveRepresentImageTargetTests(unittest.TestCase):
    def setUp(self):
        self.resolve = load_resolver()

    def test_daum_trends_selects_first_non_comic_attachment(self):
        self.assertEqual(
            self.resolve("daum-trends", ["00-comic.jpg", "01-trend.jpg", "02-trend.jpg"]),
            "01-trend.jpg",
        )

    def test_daum_trends_skips_comic_variants(self):
        self.assertEqual(
            self.resolve("daum-trends", ["00-COMIC.PNG", "01-trend.webp"]),
            "01-trend.webp",
        )
        self.assertEqual(
            self.resolve("daum-trends", ["00-comic.jpeg", "01-trend.jpg"]),
            "01-trend.jpg",
        )

    def test_daum_trends_accepts_full_paths(self):
        self.assertEqual(
            self.resolve("daum-trends", ["/tmp/run/00-comic.jpg", "/tmp/run/01-trend.jpg"]),
            "01-trend.jpg",
        )

    def test_daum_trends_fails_without_non_comic_attachment(self):
        with self.assertRaises(ValueError):
            self.resolve("daum-trends", ["00-comic.jpg"])
        with self.assertRaises(ValueError):
            self.resolve("daum-trends", [])
        with self.assertRaises(ValueError):
            self.resolve("daum-trends", None)

    def test_other_templates_keep_first_image_behavior(self):
        self.assertIsNone(self.resolve("mk-review", ["00-comic.jpg", "01-trend.jpg"]))
        self.assertIsNone(self.resolve("simple-post", ["01-trend.jpg"]))
        self.assertIsNone(self.resolve("", []))


if __name__ == "__main__":
    unittest.main()
