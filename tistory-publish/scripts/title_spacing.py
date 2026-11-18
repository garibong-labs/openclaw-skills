"""Title-only U+00B7 spacing, shared by both publishing entrypoints."""

import re
import sys


def normalize_title_spacing(title):
    """Give each middle dot one ASCII space per side, preserving dot count.

    Adjacent whitespace (including tabs/newlines/Unicode spaces) is replaced.
    Runs become `` · · ``; edge dots retain one outer space. Everything
    outside those spans is unchanged, and applying this twice is harmless.
    """
    return re.sub(
        r'\s*·(?:\s*·)*\s*',
        lambda match: ' ' + ' '.join('·' * match.group().count('·')) + ' ',
        title,
    )


if __name__ == '__main__':
    sys.stdout.write(normalize_title_spacing(sys.argv[1]))
