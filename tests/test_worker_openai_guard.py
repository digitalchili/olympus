"""Auth admission uses fake scheduler/native dependencies and never signs in."""
import sys
import io
import os
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server/workers'))
import hermes_worker as worker
import hermes_scheduled_tasks as scheduled


class OpenAIGuardTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(worker, '_set_openai_auth_guard'), 'worker must coordinate auth saves with task admission')
        worker.ACTIVE_TASKS.clear()
        self.jobs = set()
        self.scheduler = SimpleNamespace(get_running_job_ids=lambda: self.jobs, tick=lambda **kw: 1)
        self.modules = patch.dict(sys.modules, {'cron.scheduler': self.scheduler})
        self.modules.start()
        scheduled.set_scheduled_task_drain(False)
        worker._set_openai_auth_guard(False)

    def tearDown(self):
        if hasattr(self, 'modules'):
            worker.ACTIVE_TASKS.clear()
            worker._set_openai_auth_guard(False)
            self.modules.stop()

    def test_guards_count_work_and_block_new_admission_without_stopping_it(self):
        worker.ACTIVE_TASKS['running'] = 'run'
        self.jobs.add('cron')
        self.assertEqual(worker._set_openai_auth_guard(True), {'guarded': True, 'activeRuns': 2})
        with self.assertRaises(worker.WorkerError) as caught:
            worker._try_mark_task_active('new', 'request')
        self.assertEqual(caught.exception.code, 'auth_busy')
        self.assertEqual(worker.ACTIVE_TASKS, {'running': 'run'})
        self.assertEqual(scheduled.tick_scheduled_tasks(), 0)
        with self.assertRaises(worker.WorkerError):
            with worker._openai_commit_guard(): pass
        worker._set_openai_auth_guard(False)
        self.assertTrue(worker._try_mark_task_active('new', 'request'))
        self.assertFalse(scheduled._SCHEDULED_TASKS_DRAINING, 'auth guard must not change maintenance mode')

    def test_commit_requires_held_guard_and_preserves_it(self):
        with self.assertRaises(worker.WorkerError):
            with worker._openai_commit_guard(): pass
        worker._set_openai_auth_guard(True)
        with worker._openai_commit_guard(): self.assertTrue(worker.OPENAI_AUTH_GUARDED)
        self.assertTrue(worker.OPENAI_AUTH_GUARDED)

    def test_guard_and_commit_requests_preserve_reader_order(self):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        seen = []
        def handle(request_id, request):
            seen.append(request_id)
            if request_id == 'enable':
                entered.set(); release.wait(2)
            if request_id == 'disable': finished.set()
        with patch.object(worker, '_handle_openai_auth_request', side_effect=handle):
            try:
                worker._handle_request({'id': 'enable', 'type': 'auth.openai', 'action': 'guard', 'enabled': True})
                self.assertTrue(entered.wait(1))
                worker._handle_request({'id': 'commit', 'type': 'auth.openai', 'action': 'commit', 'sessionId': 'fixture'})
                worker._handle_request({'id': 'disable', 'type': 'auth.openai', 'action': 'guard', 'enabled': False})
                self.assertFalse(finished.wait(.05), 'cleanup must not overtake an uncertain guard/save')
            finally: release.set()
            self.assertTrue(finished.wait(1))
        self.assertEqual(seen, ['enable', 'commit', 'disable'])

    def test_sigterm_closes_auth_children(self):
        script = '''
import pathlib, sys
sys.path.insert(0, sys.argv[1])
import hermes_worker as worker
marker = pathlib.Path(sys.argv[2])
class Manager:
    def close(self): marker.write_text('closed')
worker._OPENAI_AUTH_MANAGER = Manager()
worker.start_scheduled_task_ticker = lambda: None
def run():
    print('ready', flush=True, file=sys.__stdout__)
    sys.stdin.readline()
worker._run_loop = run
sys.argv = [sys.argv[0]]
worker.main()
'''
        with tempfile.TemporaryDirectory() as home:
            marker = Path(home) / 'closed'
            proc = subprocess.Popen([sys.executable, '-c', script, str(Path(worker.__file__).parent), str(marker)],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, env=dict(os.environ, HOME=home, HERMES_HOME=home))
            try:
                self.assertEqual(proc.stdout.readline().strip(), 'ready')
                proc.terminate()
                proc.communicate(timeout=5)
                self.assertTrue(marker.exists(), 'normal worker stop must close private auth helpers')
            finally:
                if proc.poll() is None: proc.kill(); proc.communicate()

    def test_title_work_is_included_until_its_full_cleanup(self):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        def run(_request):
            entered.set(); release.wait(2); return {'title': 'fixture'}
        with patch.object(worker, '_result', side_effect=lambda *a: finished.set()):
            worker._submit_background_agent_request('title-id', {}, name_prefix='title', handler=run)
            self.assertTrue(entered.wait(1))
            try: self.assertEqual(worker._set_openai_auth_guard(True)['activeRuns'], 1)
            finally: release.set()
            self.assertTrue(finished.wait(1))
        self.assertEqual(worker._set_openai_auth_guard(True)['activeRuns'], 0)

    def test_typed_openai_error_is_safe_and_distinct_from_generic_auth(self):
        class AuthError(Exception):
            provider = 'openai-codex'
            code = 'invalid_grant'
            relogin_required = True
        payload = worker._error_payload(AuthError('token-secret-sentinel'))
        self.assertEqual(payload['code'], 'openai_auth_required')
        self.assertNotIn('sentinel', str(payload))
        AuthError.relogin_required = False
        self.assertEqual(worker._error_payload(AuthError('network secret'))['code'], 'openai_auth_unavailable')
        AuthError.provider = 'another-provider'
        self.assertNotEqual(worker._error_payload(AuthError('authentication secret'))['code'], 'openai_auth_required')

    def test_returned_native_auth_failure_uses_actual_provider_and_safe_reason(self):
        self.assertTrue(hasattr(worker, '_openai_result_failure'))
        result = {'failed': True, 'failure_reason': 'auth_permanent', 'error': 'secret-sentinel'}
        self.assertEqual(worker._openai_result_failure(result, 'openai-codex')[1], 'openai_auth_required')
        self.assertNotIn('sentinel', str(worker._openai_result_failure(result, 'openai-codex')))
        self.assertIsNone(worker._openai_result_failure(result, 'other-provider'))
        self.assertIsNone(worker._openai_result_failure({'failed': True, 'error': 'authentication prose'}, 'openai-codex'))

    def test_provider_failures_use_structured_categories_and_never_echo_secrets(self):
        class ProviderError(Exception):
            pass
        cases = [(401, None, 'auth_error'), (429, 'insufficient_quota', 'quota_exhausted'),
                 (429, None, 'rate_limit'), (404, 'model_not_found', 'model_error'),
                 (403, 'model_not_found', 'model_error'), (403, 'invalid_model', 'model_error'),
                 (503, None, 'provider_error')]
        for status, code, expected in cases:
            with self.subTest(expected=expected):
                error = ProviderError('secret-sentinel unauthorized credit model not found')
                error.status_code, error.code = status, code
                error.provider = 'openai'
                payload = worker._error_payload(error)
                self.assertEqual(payload['code'], expected)
                self.assertNotIn('sentinel', str(payload))
        self.assertNotIn('sentinel', str(worker._error_payload(Exception('secret-sentinel'))))

    def test_returned_failures_preserve_safe_native_reason(self):
        for reason, expected in [('auth', 'auth_error'), ('auth_permanent', 'auth_error'),
                                 ('rate_limit', 'rate_limit'), ('upstream_rate_limit', 'rate_limit'),
                                 ('quota_exhausted', 'quota_exhausted'),
                                 ('billing', 'quota_exhausted'), ('billing_unverified', 'quota_exhausted'),
                                 ('model_entitlement', 'model_error'), ('model_not_found', 'model_error'), ('unknown', 'provider_error')]:
            result = worker._agent_result_failure({'failed': True, 'failure_reason': reason, 'error': 'secret-sentinel'})
            self.assertEqual(result[1], expected)
            self.assertNotIn('sentinel', str(result))

    def test_unhandled_request_diagnostic_never_logs_exception_contents(self):
        diagnostic = io.StringIO()
        with patch.object(worker.sys, 'stdin', io.StringIO('{"id":"one","type":"health"}\n')), \
             patch.object(worker.sys, 'stderr', diagnostic), \
             patch.object(worker, '_handle_request', side_effect=RuntimeError('secret-sentinel')):
            worker._run_loop()
        self.assertIn('failed to handle request', diagnostic.getvalue())
        self.assertNotIn('secret-sentinel', diagnostic.getvalue())
        self.assertNotIn('Traceback', diagnostic.getvalue())

    def test_title_rejects_native_failed_result_before_returning_provider_text(self):
        for provider, reason, expected in [
            ('openai-codex', 'auth_permanent', 'openai_auth_required'),
            ('other-provider', 'model_not_found', 'model_error'),
            ('other-provider', 'rate_limit', 'rate_limit'),
            ('other-provider', 'unknown', 'provider_error'),
        ]:
            with self.subTest(provider=provider, reason=reason):
                agent = SimpleNamespace(provider=provider, run_conversation=lambda **_: {
                    'failed': True, 'completed': False, 'failure_reason': reason,
                    'final_response': 'secret-sentinel provider rejected the request',
                })
                with patch.object(worker, '_create_agent', return_value=agent):
                    with self.assertRaises(worker.WorkerError) as caught:
                        worker._generate_title({'description': 'Original task request'})
                self.assertEqual(caught.exception.code, expected)
                self.assertNotIn('secret-sentinel', str(worker._error_payload(caught.exception)))

    def test_title_retains_nonfailed_partial_response(self):
        agent = SimpleNamespace(provider='other-provider', run_conversation=lambda **_: {
            'failed': False, 'completed': False, 'final_response': 'Useful task title',
        })
        with patch.object(worker, '_create_agent', return_value=agent):
            self.assertEqual(worker._generate_title({'description': 'Original task request'}),
                             {'title': 'Useful task title'})


if __name__ == '__main__': unittest.main()
