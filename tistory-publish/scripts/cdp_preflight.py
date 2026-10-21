"""Bounded attach and read-only target diagnostics (Python 3.9+)."""
import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

DIAGNOSTIC_BUDGET_S = 5.0
TARGET_TIMEOUT_S = 0.75
MAX_TARGETS = 8
MAX_LIST_BYTES = 262144


def safe_target(target):
    # URLs/titles are deliberately omitted: even origin/path can carry secrets.
    target_id = target.get('id')
    kind = target.get('type')
    return {
        'id': target_id if isinstance(target_id, str) and re.fullmatch(r'[a-fA-F0-9]{1,64}', target_id) else 'redacted',
        'type': kind if kind in ('page', 'iframe', 'worker', 'service_worker', 'shared_worker', 'background_page', 'other') else 'other',
    }


def probe_target(port, target_id, connect, deadline, timeout_error):
    """Only constant evaluation on a direct page socket; never enable/mutate domains."""
    sock = None
    evaluating = False
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return 'unknown', 'budget_exhausted'
        sock = connect('ws://127.0.0.1:{}/devtools/page/{}'.format(port, target_id),
                       timeout=remaining, suppress_origin=True, http_no_proxy=['127.0.0.1'])
        sock.settimeout(max(0.001, deadline - time.monotonic()))
        sock.send(json.dumps({'id': 1, 'method': 'Runtime.evaluate',
                              'params': {'expression': '1', 'returnByValue': True, 'timeout': 500}}))
        evaluating = True
        # Bound event floods as well as each blocking receive.
        for _ in range(32):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return 'unresponsive', 'evaluation_timeout'
            sock.settimeout(remaining)
            raw = sock.recv()
            if not isinstance(raw, str) or len(raw) > MAX_LIST_BYTES:
                return 'unknown', 'invalid_response'
            response = json.loads(raw)
            if response.get('id') != 1:
                continue
            if response.get('result', {}).get('result', {}).get('value') == 1:
                return 'responsive', 'constant_evaluation'
            # CDP errors do not establish a stalled renderer.
            return 'unknown', 'evaluation_error'
        return 'unknown', 'event_limit'
    except timeout_error:
        return ('unresponsive', 'evaluation_timeout') if evaluating else ('unknown', 'transport_timeout')
    except Exception:
        return 'unknown', 'transport_error'
    finally:
        if sock is not None:
            try:
                # Avoid a WebSocket close handshake wait.
                sock.shutdown()
            except Exception:
                pass


def diagnose_targets(port, emit, connect=None, timeout_error=TimeoutError):
    deadline = time.monotonic() + DIAGNOSTIC_BUDGET_S
    try:
        # No proxies, redirects, arbitrary browser-advertised endpoints or metadata logs.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open('http://127.0.0.1:{}/json/list'.format(port),
                         timeout=min(TARGET_TIMEOUT_S, deadline - time.monotonic())) as response:
            raw = response.read(MAX_LIST_BYTES + 1)
        if len(raw) > MAX_LIST_BYTES:
            raise ValueError()
        targets = json.loads(raw)
        if not isinstance(targets, list):
            raise ValueError()
    except Exception:
        emit({'stage': 'target_list', 'status': 'unknown', 'reason': 'list_unavailable'})
        return
    for target in targets[:MAX_TARGETS]:
        if not isinstance(target, dict):
            continue
        record = safe_target(target)
        record['stage'] = 'target_probe'
        started = time.monotonic()
        if started >= deadline:
            status, reason = 'unknown', 'budget_exhausted'
        elif record['type'] != 'page' or record['id'] == 'redacted':
            status, reason = 'unknown', 'unsupported_target'
        elif connect is None:
            status, reason = 'unknown', 'transport_unavailable'
        else:
            status, reason = probe_target(port, record['id'], connect,
                                           min(deadline, started + TARGET_TIMEOUT_S), timeout_error)
        record.update(status=status, reason=reason, duration_ms=int((time.monotonic() - started) * 1000))
        emit(record)
    emit({'stage': 'target_summary', 'status': 'unknown', 'enumerated': min(len(targets), MAX_TARGETS),
          'omitted': max(0, len(targets) - MAX_TARGETS)})


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def run_diagnostics(port, log):
    """Separate process is a hard wall-clock cap, including optional transport/imports."""
    started = time.monotonic()
    try:
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--diagnose', str(port)],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=DIAGNOSTIC_BUDGET_S, check=False)
        output = result.stdout
        reason = 'finished' if result.returncode == 0 else 'worker_failed'
    except subprocess.TimeoutExpired as exc:
        output = exc.stdout or b''
        reason = 'budget_exhausted'
    except Exception:
        output = b''
        reason = 'worker_unavailable'
    # Output is generated only by this worker; never relay malformed/raw lines.
    for line in output.splitlines()[:MAX_TARGETS + 1]:
        try:
            record = json.loads(line)
            if record.get('stage') == 'target_probe':
                safe = safe_target(record)
                safe.update(stage='target_probe', status=record['status'], reason=record['reason'],
                            duration_ms=record['duration_ms'])
                if safe['status'] not in ('responsive', 'unresponsive', 'unknown'):
                    continue
                if safe['reason'] not in ('budget_exhausted', 'unsupported_target', 'transport_unavailable',
                                          'constant_evaluation', 'evaluation_timeout', 'evaluation_error',
                                          'event_limit', 'invalid_response', 'transport_timeout', 'transport_error'):
                    continue
                if type(safe['duration_ms']) is not int or not 0 <= safe['duration_ms'] <= 60000:
                    continue
                log('CDP diagnostic ' + json.dumps(safe, sort_keys=True))
            elif record.get('stage') == 'target_list' and record.get('reason') == 'list_unavailable':
                log('CDP diagnostic stage=target_list status=unknown reason=list_unavailable')
            elif record.get('stage') == 'target_summary':
                count, omitted = record['enumerated'], record['omitted']
                if type(count) is int and type(omitted) is int and 0 <= count <= MAX_TARGETS and omitted >= 0:
                    log('CDP diagnostic targets={} omitted={}'.format(count, omitted))
        except Exception:
            continue
    log('CDP diagnostic stage=complete status=unknown reason={} duration_ms={}'.format(
        reason, int((time.monotonic() - started) * 1000)))


def connect_preflight(chromium, port, timeout_ms, log):
    """Return the one real Playwright connection, or fail before any editor access."""
    started = time.monotonic()
    try:
        browser = chromium.connect_over_cdp('http://127.0.0.1:{}'.format(port), timeout=timeout_ms)
    except Exception:
        log('CDP stage=attach status=failed duration_ms={}'.format(int((time.monotonic() - started) * 1000)))
        try:
            run_diagnostics(port, log)
        except Exception:
            # Diagnostics must never replace the stable primary attach error.
            pass
        # No exception chain: Playwright messages can contain secret endpoint URLs.
        raise RuntimeError('publish/cdp-attach-failed') from None
    log('CDP stage=attach status=connected duration_ms={}'.format(int((time.monotonic() - started) * 1000)))
    return browser


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != '--diagnose' or not sys.argv[2].isdigit() or not 1 <= int(sys.argv[2]) <= 65535:
        sys.exit(2)
    try:
        import websocket  # Optional websocket-client; never installed automatically.
        connector, timeout_class = websocket.create_connection, websocket.WebSocketTimeoutException
    except ImportError:
        connector, timeout_class = None, TimeoutError
    diagnose_targets(int(sys.argv[2]), lambda record: print(json.dumps(record), flush=True), connector, timeout_class)
