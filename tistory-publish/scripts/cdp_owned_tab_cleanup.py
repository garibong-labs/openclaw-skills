"""Close one captured run-owned page; confirm disappearance (Python 3.9+)."""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import quote

BUDGET_S = 5
MAX_RESPONSE_BYTES = 262144


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def close_target(port, target_id):
    """Worker: never select targets by URL, title, position or another page."""
    deadline = time.monotonic() + 4.5
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def read(path):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        with opener.open('http://127.0.0.1:{}/json/{}'.format(port, path),
                         timeout=min(0.75, remaining)) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError()
        return raw

    def targets():
        entries = json.loads(read('list'))
        if not isinstance(entries, list) or any(
            not isinstance(entry, dict) or not isinstance(entry.get('id'), str)
            or not entry['id'] for entry in entries
        ):
            raise ValueError()
        return [entry for entry in entries if entry['id'] == target_id]

    try:
        matches = targets()
        if not matches:
            return 'target_missing'
        if len(matches) != 1 or matches[0].get('type') != 'page':
            return 'identity_mismatch'
        try:
            read('close/' + quote(target_id, safe=''))
        except Exception:
            # A lost close response can still mean the exact target disappeared.
            pass
        backoff = 1.0
        while time.monotonic() < deadline:
            matches = targets()
            if not matches:
                return 'closed'
            if len(matches) != 1 or matches[0].get('type') != 'page':
                return 'identity_mismatch'
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(backoff, remaining))
            backoff *= 2
        return 'unconfirmed'
    except Exception:
        return 'unconfirmed'


def cleanup_owned_target(port, target_id):
    """Hard outer timeout also bounds trickling HTTP responses and child shutdown."""
    try:
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), str(port), target_id],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=BUDGET_S, check=False,
        )
        status = result.stdout.decode('ascii').strip()
        if result.returncode == 0 and status in (
            'closed', 'target_missing', 'identity_mismatch', 'unconfirmed',
        ):
            return status
    except subprocess.TimeoutExpired:
        return 'timeout'
    except Exception:
        pass
    return 'unconfirmed'


if __name__ == '__main__':
    print(close_target(int(sys.argv[1]), sys.argv[2]))
