import ast
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import tempfile
import unittest
import warnings
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
spec = importlib.util.spec_from_file_location('cdp_preflight', SCRIPTS / 'cdp_preflight.py')
cdp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cdp)


class Socket:
    def __init__(self, replies=None, error=None):
        self.replies = iter(replies or [])
        self.error = error
        self.sent = []
        self.closed = False

    def settimeout(self, value):
        assert 0 < value <= 1

    def send(self, message):
        self.sent.append(json.loads(message))

    def recv(self):
        if self.error:
            raise self.error
        return next(self.replies)

    def shutdown(self):
        self.closed = True


def list_opener(targets):
    response = Mock()
    response.read.return_value = json.dumps(targets).encode()
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    opener = Mock()
    opener.open.return_value = response
    return opener


class PreflightTests(unittest.TestCase):
    def test_cold_and_healthy_connect_reuses_exact_browser_once(self):
        for duration in (0.485, 2.0):
            with self.subTest(duration=duration):
                chromium, log = Mock(), Mock()
                with patch.object(cdp.time, 'monotonic', side_effect=[10, 10 + duration]), patch.object(cdp, 'run_diagnostics') as diag:
                    browser = cdp.connect_preflight(chromium, 43210, 15000, log)
                self.assertIs(browser, chromium.connect_over_cdp.return_value)
                chromium.connect_over_cdp.assert_called_once_with('http://127.0.0.1:43210', timeout=15000)
                diag.assert_not_called()
                self.assertIn('status=connected duration_ms=', log.call_args.args[0])

    def test_attach_failure_diagnostics_cannot_mask_or_leak_primary(self):
        chromium, logs = Mock(), []
        chromium.connect_over_cdp.side_effect = RuntimeError('ws://secret/?token=PASSWORD')
        with patch.object(cdp, 'run_diagnostics', side_effect=ValueError('PRIVATE')) as diag:
            with self.assertRaisesRegex(RuntimeError, '^publish/cdp-attach-failed$') as failure:
                cdp.connect_preflight(chromium, 43210, 1000, logs.append)
        self.assertTrue(failure.exception.__suppress_context__)
        self.assertNotIn('PASSWORD', str(logs))
        self.assertNotIn('PRIVATE', str(logs))
        self.assertIn('stage=attach status=failed', logs[0])
        diag.assert_called_once()

    def test_operator_interrupts_propagate_at_attach_and_diagnostic(self):
        chromium = Mock()
        for stage in ('attach', 'diagnostic'):
            chromium.connect_over_cdp.side_effect = KeyboardInterrupt() if stage == 'attach' else RuntimeError()
            with patch.object(cdp, 'run_diagnostics', side_effect=KeyboardInterrupt()):
                with self.assertRaises(KeyboardInterrupt):
                    cdp.connect_preflight(chromium, 43210, 1000, Mock())

    def test_healthy_target_proves_constant_evaluation_on_direct_channel(self):
        sock = Socket([json.dumps({'method': 'event'}), json.dumps({'id': 1, 'result': {'result': {'value': 1}}})])
        connect = Mock(return_value=sock)
        result = cdp.probe_target(43210, 'ABC123', connect, time.monotonic() + .75, TimeoutError)
        self.assertEqual(result, ('responsive', 'constant_evaluation'))
        self.assertEqual(connect.call_args.args[0], 'ws://127.0.0.1:43210/devtools/page/ABC123')
        self.assertEqual(sock.sent, [{'id': 1, 'method': 'Runtime.evaluate', 'params': {'expression': '1', 'returnByValue': True, 'timeout': 500}}])
        self.assertTrue(sock.closed)

    def test_stalled_target_is_unresponsive_only_after_transport_connects(self):
        sock = Socket(error=TimeoutError('secret'))
        self.assertEqual(cdp.probe_target(1, 'AA', Mock(return_value=sock), time.monotonic() + .75, TimeoutError),
                         ('unresponsive', 'evaluation_timeout'))
        self.assertTrue(sock.closed)
        self.assertEqual(cdp.probe_target(1, 'AA', Mock(side_effect=TimeoutError()), time.monotonic() + .75, TimeoutError),
                         ('unknown', 'transport_timeout'))

    def test_protocol_error_and_event_flood_are_not_health_proof(self):
        for replies, reason in [([json.dumps({'id': 1, 'error': {'message': 'secret'}})], 'evaluation_error'),
                                ([json.dumps({'method': 'event'})] * 32, 'event_limit'),
                                (['not json SECRET'], 'transport_error')]:
            result = cdp.probe_target(1, 'AA', Mock(return_value=Socket(replies)), time.monotonic() + .75, TimeoutError)
            self.assertEqual(result, ('unknown', reason))

    def test_optional_transport_missing_reports_targets_unknown_without_metadata(self):
        records = []
        targets = [{'id': 'ABC123', 'type': 'page', 'url': 'https://user:secret@host/token?password#secret',
                    'title': 'PRIVATE', 'webSocketDebuggerUrl': 'ws://evil/?secret'}]
        with patch.object(cdp.urllib.request, 'build_opener', return_value=list_opener(targets)):
            cdp.diagnose_targets(43210, records.append)
        self.assertEqual(records[0]['status'], 'unknown')
        self.assertEqual(records[0]['reason'], 'transport_unavailable')
        self.assertEqual(records[0]['id'], 'ABC123')
        self.assertNotIn('secret', json.dumps(records))
        self.assertNotIn('PRIVATE', json.dumps(records))

    def test_max_targets_and_total_deadline(self):
        records = []
        targets = [{'id': 'AA', 'type': 'page'}] * 12
        clock = Mock(return_value=10)
        def stalled(*args):
            clock.return_value += .75
            return 'unresponsive', 'evaluation_timeout'
        with patch.object(cdp.time, 'monotonic', clock), patch.object(cdp, 'probe_target', side_effect=stalled) as probe, patch.object(cdp.urllib.request, 'build_opener', return_value=list_opener(targets)):
            cdp.diagnose_targets(43210, records.append, Mock())
        self.assertEqual(probe.call_count, 7)
        self.assertEqual(records[-2]['reason'], 'budget_exhausted')
        self.assertEqual(records[-1]['omitted'], 4)
        for call in probe.call_args_list:
            self.assertLessEqual(call.args[3], 15)

    def test_unsafe_target_identity_and_unsupported_type_are_unknown(self):
        targets = [{'id': 'token?SECRET', 'type': 'SECRET'}, {'id': 'AA', 'type': 'worker'}]
        records, connect = [], Mock()
        with patch.object(cdp.urllib.request, 'build_opener', return_value=list_opener(targets)):
            cdp.diagnose_targets(43210, records.append, connect)
        connect.assert_not_called()
        self.assertEqual(records[0]['id'], 'redacted')
        self.assertNotIn('SECRET', json.dumps(records))
        self.assertTrue(all(r['status'] == 'unknown' for r in records))

    def test_list_failure_and_oversized_list_do_not_expose_exception(self):
        for opener in (Mock(), list_opener([])):
            opener.open.side_effect = RuntimeError('SECRET')
            records = []
            with patch.object(cdp.urllib.request, 'build_opener', return_value=opener):
                cdp.diagnose_targets(1, records.append)
            self.assertEqual(records, [{'stage': 'target_list', 'status': 'unknown', 'reason': 'list_unavailable'}])
        opener = list_opener([])
        opener.open.return_value.read.return_value = b' ' * (cdp.MAX_LIST_BYTES + 1)
        with patch.object(cdp.urllib.request, 'build_opener', return_value=opener):
            records = []
            cdp.diagnose_targets(1, records.append)
        self.assertEqual(records[0]['reason'], 'list_unavailable')

    def test_worker_hard_deadline_reaps_stuck_process_preserves_completed_records(self):
        # Local synthetic Python process only: no browser, socket or network.
        real_run = subprocess.run
        record = {'stage': 'target_probe', 'id': 'AA', 'type': 'page', 'status': 'unresponsive',
                  'reason': 'evaluation_timeout', 'duration_ms': 50}
        program = 'import time; print({!r}, flush=True); time.sleep(60)'.format(json.dumps(record))
        def stuck_worker(command, **kwargs):
            return real_run([sys.executable, '-c', program], **kwargs)
        logs = []
        started = time.monotonic()
        with patch.object(cdp, 'DIAGNOSTIC_BUDGET_S', .2), patch.object(cdp.subprocess, 'run', side_effect=stuck_worker):
            cdp.run_diagnostics(43210, logs.append)
        self.assertLess(time.monotonic() - started, 2)
        self.assertIn('unresponsive', logs[0])
        self.assertIn('reason=budget_exhausted', logs[-1])

    def test_failed_full_attach_diagnoses_healthy_and_stalled_targets_independently(self):
        chromium, logs = Mock(), []
        chromium.connect_over_cdp.side_effect = TimeoutError('secret endpoint')
        targets = [{'id': 'AA', 'type': 'page'}, {'id': 'BB', 'type': 'page'}]
        sockets = [Socket([json.dumps({'id': 1, 'result': {'result': {'value': 1}}})]),
                   Socket(error=TimeoutError())]
        def diagnostic_worker(command, **kwargs):
            records = []
            with patch.object(cdp.urllib.request, 'build_opener', return_value=list_opener(targets)):
                cdp.diagnose_targets(43210, records.append, Mock(side_effect=sockets))
            return subprocess.CompletedProcess(command, 0, stdout='\n'.join(json.dumps(r) for r in records).encode())
        with patch.object(cdp.subprocess, 'run', side_effect=diagnostic_worker):
            with self.assertRaisesRegex(RuntimeError, '^publish/cdp-attach-failed$'):
                cdp.connect_preflight(chromium, 43210, 1000, logs.append)
        chromium.connect_over_cdp.assert_called_once()
        probes = [json.loads(line[len('CDP diagnostic '):]) for line in logs if '"stage": "target_probe"' in line]
        self.assertEqual([(r['id'], r['status']) for r in probes], [('AA', 'responsive'), ('BB', 'unresponsive')])
        self.assertTrue(all(sock.closed for sock in sockets))
        self.assertNotIn('secret endpoint', str(logs))

    def test_diagnostic_subprocess_interruption_is_preserved(self):
        with patch.object(cdp.subprocess, 'run', side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):
                cdp.run_diagnostics(43210, Mock())

    def test_worker_output_is_filtered_and_stderr_discarded(self):
        logs = []
        result = subprocess.CompletedProcess([], 1, stdout=b'SECRET\n{"stage":"target_probe","id":"AA","type":"page","status":"unknown","reason":"SECRET","duration_ms":1}\n')
        with patch.object(cdp.subprocess, 'run', return_value=result) as run:
            cdp.run_diagnostics(43210, logs.append)
        self.assertNotIn('SECRET', str(logs))
        self.assertIs(run.call_args.kwargs['stderr'], subprocess.DEVNULL)
        self.assertEqual(run.call_args.kwargs['timeout'], 5)

    def test_invalid_timeout_and_port_fail_before_python_or_browser_access(self):
        with tempfile.NamedTemporaryFile(mode='w', suffix='.html') as body:
            body.write('<p>offline test</p>')
            body.flush()
            env = dict(os.environ, ALLOW_DIRECT_TISTORY_PUBLISH='1', TISTORY_SEO_CHECK='off',
                       TISTORY_CDP_PORT='43210', TISTORY_CDP_CONNECT_TIMEOUT_MS='15000',
                       REQUIRE_PUBLIC_IMAGE_FIGURES='0', TISTORY_SEO_MIN_BODY_CHARS='1000')
            for option, value in [('--cdp-connect-timeout-ms', '0'), ('--cdp-connect-timeout-ms', '60001'),
                                  ('--cdp-connect-timeout-ms', 'nan'), ('--cdp-port', '0'), ('--cdp-port', '65536')]:
                result = subprocess.run(['bash', str(SCRIPTS / 'publish-post.sh'), '--title', 'offline',
                                         '--body-file', body.name, '--category', 'offline', option, value],
                                        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=2)
                self.assertEqual(result.returncode, 1)
                self.assertIn('must be', json.loads(result.stdout)['error'])
                self.assertNotIn(b'Launching Playwright', result.stderr)

    def test_current_path_attaches_after_lock_before_new_page_and_login(self):
        source = (SCRIPTS / 'publish-post.sh').read_text()
        embedded = re.search(r"<< 'PYTHON_SCRIPT'\n(.*?)\nPYTHON_SCRIPT\n", source, re.S).group(1)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', SyntaxWarning)
            warnings.simplefilter('ignore', DeprecationWarning)
            ast.parse(embedded, feature_version=(3, 9))
        self.assertEqual(source.count('connect_preflight(p.chromium,'), 1)
        self.assertNotIn('connect_over_cdp(', source)
        self.assertNotIn('cleanup_newpost_targets', source)
        self.assertNotIn('pg.close()', source)
        attach = source.index('browser = connect_preflight(')
        self.assertLess(source.index('publish_lock.acquire()'), attach)
        self.assertLess(attach, source.index('page = ctx0.new_page()'))
        self.assertIn("fail('publish/cdp-attach-failed')", source[attach:source.index('page = ctx0.new_page()')])
        self.assertIn('${TISTORY_CDP_CONNECT_TIMEOUT_MS:-15000}', source)


if __name__ == '__main__':
    unittest.main()
