"""Device authentication lifecycle; fixtures never load Hermes or real credentials."""
from __future__ import annotations

from contextlib import contextmanager
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server' / 'workers'))


class FakeNative:
    def __init__(self):
        self.events = []
        self.cancelled = 0
        self.saves = []
        self.checks = 0
        self.failure = None

    def start(self, callback):
        self.events.append(callback)
        return self

    def cancel(self):
        self.cancelled += 1

    def check(self):
        self.checks += 1
        return {'state': 'saved_login_ready', 'credentialScope': 'shared_default', 'code': None}

    def save(self, tokens, expires_at):
        if self.failure:
            raise self.failure
        self.saves.append(dict(tokens))


class OpenAIAuthTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('hermes_openai_auth'), 'OpenAI auth manager is missing')
        from hermes_openai_auth import OpenAIAuthManager
        from hermes_worker_utils import WorkerError
        self.WorkerError = WorkerError
        self.time = 1000.0
        self.busy = False
        self.native = FakeNative()
        self.saved_callbacks = 0

        @contextmanager
        def guard():
            if self.busy:
                raise WorkerError('Busy', code='auth_busy')
            yield

        self.manager = OpenAIAuthManager(
            hermes_home=Path('/fixture-only'), agent_dir=lambda: Path('/fixture-source'),
            is_default=True, commit_guard=guard, native=self.native,
            clock=lambda: self.time, schedule=lambda seconds, callback: None,
            on_saved=self.on_saved,
        )

    def on_saved(self):
        self.saved_callbacks += 1

    def tearDown(self):
        if hasattr(self, 'manager'):
            self.manager.close()

    def start(self):
        return self.manager.handle({'action': 'start'})['session']['sessionId']

    def emit_device(self, callback=None, expires=60):
        (callback or self.native.events[-1])({
            'type': 'device', 'userCode': 'ABCD-EFGH', 'expiresIn': expires,
            'pollIntervalMs': 5000, 'verificationUrl': 'https://evil.example',
            'device_auth_id': 'PRIVATE-DEVICE',
        })

    def emit_tokens(self, callback=None, **tokens):
        (callback or self.native.events[-1])({'type': 'tokens', 'tokens': {
            'access_token': 'PRIVATE-ACCESS', 'refresh_token': 'PRIVATE-REFRESH', **tokens,
        }})

    def poll(self, sid):
        return self.manager.handle({'action': 'poll', 'sessionId': sid})

    def test_cold_status_does_not_read_native_state(self):
        result = self.manager.handle({'action': 'status'})
        self.assertEqual(result['status'], {'provider': 'openai-codex', 'state': 'unknown',
            'checkedAt': None, 'credentialScope': 'unknown', 'code': None})
        self.assertIsNone(result['session'])
        self.assertEqual(self.native.checks, 0)
        self.assertEqual(self.native.events, [])

    def test_check_updates_cache_without_starting_device_flow(self):
        result = self.manager.handle({'action': 'check'})
        self.assertEqual(result['status']['state'], 'saved_login_ready')
        self.assertEqual(result['status']['checkedAt'], 1000000)
        self.assertEqual(self.native.events, [])
        self.assertEqual(self.manager.handle({'action': 'status'}), result)

    def test_invalidation_removes_stale_verified_claim_without_native_calls(self):
        self.manager.handle({'action': 'check'})
        result = self.manager.handle({'action': 'invalidate'})
        self.assertEqual(result['status']['state'], 'unknown')
        self.assertEqual(result['status']['credentialScope'], 'shared_default')
        self.assertIsNone(result['status']['checkedAt'])
        self.assertEqual(self.native.checks, 1)

    def test_unsupported_native_check_remains_safe_and_actionable(self):
        def unavailable():
            raise self.WorkerError('PRIVATE-NATIVE-ERROR', code='auth_unsupported')
        self.native.check = unavailable
        result = self.manager.handle({'action': 'check'})
        self.assertEqual(result['status']['state'], 'temporarily_unavailable')
        self.assertEqual(result['status']['code'], 'auth_unsupported')
        self.assertNotIn('PRIVATE-', json.dumps(result))

    def test_duplicate_start_and_reload_reuse_attempt(self):
        sid = self.start()
        self.assertEqual(self.start(), sid)
        self.assertEqual(len(self.native.events), 1)
        self.emit_device()
        result = self.manager.handle({'action': 'status'})
        self.assertEqual(result['session']['state'], 'awaiting_user')
        self.assertEqual(result['session']['verificationUrl'], 'https://auth.openai.com/codex/device')
        self.assertNotIn('PRIVATE-DEVICE', json.dumps(result))

    def test_poll_never_saves_and_commit_waits_for_guard(self):
        sid = self.start()
        self.emit_device()
        self.emit_tokens()
        self.assertEqual(self.poll(sid)['session']['state'], 'waiting_for_idle')
        self.assertEqual(self.native.saves, [])
        self.busy = True
        self.assertEqual(self.manager.handle({'action': 'commit', 'sessionId': sid})['session']['state'], 'waiting_for_idle')
        self.busy = False
        result = self.manager.handle({'action': 'commit', 'sessionId': sid})
        self.assertEqual(result['session']['state'], 'saved')
        self.assertEqual(len(self.native.saves), 1)
        self.assertEqual(result['status']['credentialScope'], 'shared_default')
        self.assertEqual(self.saved_callbacks, 1)
        self.assertIsNone(result['session']['userCode'])
        self.assertNotIn('PRIVATE-', json.dumps(result))
        self.manager.handle({'action': 'commit', 'sessionId': sid})
        self.assertEqual(len(self.native.saves), 1)

    def test_cancel_prevents_late_completion_and_replacement_isolated(self):
        sid = self.start()
        old = self.native.events[-1]
        self.manager.handle({'action': 'cancel', 'sessionId': sid})
        self.assertGreater(self.native.cancelled, 0)
        self.emit_device(old)
        self.emit_tokens(old)
        self.assertEqual(self.poll(sid)['session']['state'], 'cancelled')
        newer = self.start()
        self.emit_tokens(old)
        self.assertNotEqual(newer, sid)
        self.assertEqual(self.poll(newer)['session']['state'], 'starting')
        self.assertEqual(self.native.saves, [])

    def test_expiry_prevents_save_after_ready_even_without_browser_cancel(self):
        sid = self.start()
        self.emit_device(expires=10)
        self.emit_tokens()
        self.time += 10
        result = self.manager.handle({'action': 'commit', 'sessionId': sid})
        self.assertEqual(result['session']['state'], 'expired')
        self.assertEqual(self.native.saves, [])
        self.assertIsNone(result['session']['userCode'])

    def test_timer_expires_without_any_browser_poll(self):
        callbacks = []
        self.manager.schedule = lambda seconds, callback: callbacks.append(callback)
        self.start()
        self.emit_device(expires=10)
        self.emit_tokens()
        self.time += 10
        callbacks[-1]()
        self.assertEqual(self.manager.handle({'action': 'status'})['session']['state'], 'expired')
        self.assertEqual(self.native.saves, [])

    def test_native_save_expiry_stays_expired(self):
        sid = self.start()
        self.emit_device()
        self.emit_tokens()
        self.native.failure = self.WorkerError('private', code='auth_expired')
        result = self.manager.handle({'action': 'commit', 'sessionId': sid})
        self.assertEqual(result['session']['state'], 'expired')

    def test_incomplete_tokens_are_terminal_and_private(self):
        sid = self.start()
        self.emit_device()
        self.emit_tokens(refresh_token='')
        result = self.poll(sid)
        self.assertEqual(result['session']['code'], 'auth_incomplete_credentials')
        self.assertEqual(result['session']['state'], 'failed')
        self.assertNotIn('PRIVATE-', json.dumps(result))

    def test_helper_errors_are_allowlisted(self):
        sid = self.start()
        self.native.events[-1]({'type': 'error', 'code': 'PRIVATE-TOKEN', 'message': 'PRIVATE-TOKEN'})
        result = self.poll(sid)
        self.assertEqual(result['session']['code'], 'openai_auth_unavailable')
        self.assertNotIn('PRIVATE-', json.dumps(result))

    def test_account_mismatch_is_safe_terminal_failure(self):
        sid = self.start()
        self.emit_device()
        self.emit_tokens()
        self.native.failure = self.WorkerError('PRIVATE-TOKEN', code='auth_account_mismatch')
        result = self.manager.handle({'action': 'commit', 'sessionId': sid})
        self.assertEqual(result['session']['code'], 'auth_account_mismatch')
        self.assertEqual(result['session']['state'], 'failed')
        self.assertEqual(self.native.saves, [])
        self.assertNotIn('PRIVATE-', json.dumps(result))

    def test_uncertain_save_invalidates_previously_ready_status(self):
        self.manager.handle({'action': 'check'})
        sid = self.start()
        self.emit_device()
        self.emit_tokens()
        def save_then_fail(tokens, expires_at):
            self.native.saves.append(dict(tokens))
            raise self.WorkerError('PRIVATE-STORAGE-ERROR', code='auth_storage_failed')
        self.native.save = save_then_fail
        result = self.manager.handle({'action': 'commit', 'sessionId': sid})
        self.assertEqual(len(self.native.saves), 1)
        self.assertEqual(result['session']['state'], 'failed')
        self.assertEqual(result['session']['code'], 'auth_storage_failed')
        self.assertEqual(result['status']['state'], 'unknown')
        self.assertIsNone(result['status']['checkedAt'])
        self.assertNotIn('PRIVATE-', json.dumps(result))

    def test_wrong_session_rejected(self):
        self.start()
        with self.assertRaises(self.WorkerError) as exc:
            self.poll('wrong-profile-session')
        self.assertEqual(exc.exception.code, 'auth_session_invalid')

    def test_close_cancels_and_late_result_cannot_save(self):
        sid = self.start()
        self.emit_device()
        self.manager.close()
        self.emit_tokens()
        self.assertEqual(self.poll(sid)['session']['state'], 'cancelled')
        self.assertEqual(self.native.saves, [])

    def test_close_terminates_native_save_before_waiting_for_manager_lock(self):
        sid = self.start()
        self.emit_device()
        self.emit_tokens()
        saving, closed, release = threading.Event(), threading.Event(), threading.Event()
        def blocked_save(tokens, expires_at):
            saving.set()
            release.wait(3)
            raise self.WorkerError('Fixture helper terminated', code='auth_storage_failed')
        def close_native():
            closed.set()
            release.set()
        self.native.save = blocked_save
        self.native.close = close_native
        commit = threading.Thread(target=lambda: self.manager.handle({'action': 'commit', 'sessionId': sid}), daemon=True)
        closing = threading.Thread(target=self.manager.close, daemon=True)
        try:
            commit.start()
            self.assertTrue(saving.wait(1))
            closing.start()
            self.assertTrue(closed.wait(0.5), 'close must stop the auth-only child before waiting for commit to release the manager lock')
            closing.join(1)
            self.assertFalse(closing.is_alive())
        finally:
            release.set()
            commit.join(1)
            if closing.ident:
                closing.join(1)


class NativeBridgeTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('hermes_openai_auth_helper'), 'Native helper is missing')
        import hermes_openai_auth_helper as helper
        self.helper = helper
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.store = {'providers': {}, 'credential_pool': {}}
        self.root = {'providers': {'openai-codex': {'tokens': {
            'access_token': 'account-a', 'refresh_token': 'old-refresh'}}}}
        self.saved = []

        @contextmanager
        def transaction(provider):
            yield self.store, self.store['providers'].get(provider) or self.root['providers'].get(provider), self.home / 'auth.json'

        def save(tokens, **kwargs):
            self.saved.append(kwargs)
            self.store['providers']['openai-codex'] = {'tokens': dict(tokens)}

        self.auth = SimpleNamespace(_provider_state_transaction=transaction,
                                    _load_global_auth_store=lambda: self.root)
        self.codex = SimpleNamespace(_save_codex_tokens=save,
            resolve_codex_runtime_credentials=lambda **kw: {'api_key': 'PRIVATE-TOKEN'})
        self.principal = lambda token: (token, 'subject') if token else None

    def tearDown(self):
        if hasattr(self, 'tmp'):
            self.tmp.cleanup()

    def test_named_save_ignores_inherited_account_and_preserves_default_selection(self):
        self.helper.save_login(self.auth, self.codex, self.principal, self.home,
                              {'tokens': {'access_token': 'account-b', 'refresh_token': 'new'}, 'expiresAt': 1100000}, clock=lambda: 1000)
        self.assertEqual(self.saved, [{'set_active': False, 'write_through': False}])
        self.assertEqual(self.root['providers']['openai-codex']['tokens']['access_token'], 'account-a')
        receipt = (self.home / 'olympus-openai-auth.json').read_text()
        self.assertNotIn('account-b', receipt)
        self.assertNotIn('new', receipt)
        self.assertEqual((self.home / 'olympus-openai-auth.json').stat().st_mode & 0o777, 0o600)

    def test_known_owned_account_survives_token_loss_and_blocks_replacement(self):
        payload = {'tokens': {'access_token': 'account-a', 'refresh_token': 'new'}, 'expiresAt': 1100000}
        self.helper.save_login(self.auth, self.codex, self.principal, self.home, payload, clock=lambda: 1000)
        self.store['providers'].clear()
        payload['tokens']['access_token'] = 'account-b'
        with self.assertRaises(Exception) as exc:
            self.helper.save_login(self.auth, self.codex, self.principal, self.home, payload, clock=lambda: 1000)
        self.assertEqual(exc.exception.code, 'auth_account_mismatch')
        self.assertEqual(len(self.saved), 1)

    def test_known_owned_login_loss_cannot_fall_back_to_shared_account_on_check(self):
        payload = {'tokens': {'access_token': 'profile-account', 'refresh_token': 'new'}, 'expiresAt': 1100000}
        self.helper.save_login(self.auth, self.codex, self.principal, self.home, payload, clock=lambda: 1000)
        self.store['providers'].clear()
        def must_not_adopt(**kwargs):
            self.fail('Checking a missing owned login must not adopt the shared account')
        self.codex.resolve_codex_runtime_credentials = must_not_adopt
        for is_default, scope in ((False, 'profile'), (True, 'shared_default')):
            with self.subTest(is_default=is_default):
                result = self.helper.check_login(self.auth, self.codex, self.principal, self.home, is_default)
                self.assertEqual(result, {'state': 'reconnect_required', 'credentialScope': scope, 'code': 'openai_auth_required'})

    def test_native_write_then_failure_is_reported_as_uncertain_storage(self):
        def save_then_fail(tokens, **kwargs):
            self.store['providers']['openai-codex'] = {'tokens': dict(tokens)}
            raise OSError('PRIVATE-STORAGE-ERROR')
        self.codex._save_codex_tokens = save_then_fail
        with self.assertRaises(Exception) as exc:
            self.helper.save_login(self.auth, self.codex, self.principal, self.home,
                {'tokens': {'access_token': 'account-b', 'refresh_token': 'new'}, 'expiresAt': 1100000}, clock=lambda: 1000)
        self.assertEqual(getattr(exc.exception, 'code', None), 'auth_storage_failed')
        self.assertIn('openai-codex', self.store['providers'])
        self.assertNotIn('PRIVATE-', str(exc.exception))

    def test_receipt_failure_after_native_write_is_resolved_by_explicit_check(self):
        payload = {'tokens': {'access_token': 'account-b', 'refresh_token': 'new'}, 'expiresAt': 1100000}
        with patch.object(self.helper, '_write_receipt', side_effect=OSError('PRIVATE-RECEIPT-ERROR')):
            with self.assertRaises(Exception) as exc:
                self.helper.save_login(self.auth, self.codex, self.principal, self.home, payload, clock=lambda: 1000)
        self.assertEqual(exc.exception.code, 'auth_storage_failed')
        self.assertEqual(len(self.saved), 1, 'the native write must not be rolled back or silently repeated')
        self.assertEqual(self.helper.check_login(self.auth, self.codex, self.principal, self.home, False),
            {'state': 'saved_login_ready', 'credentialScope': 'profile', 'code': None})
        self.assertTrue((self.home / 'olympus-openai-auth.json').is_file())

    def test_save_rechecks_expiry_inside_storage_transaction(self):
        with self.assertRaises(Exception) as exc:
            self.helper.save_login(self.auth, self.codex, self.principal, self.home,
                {'tokens': {'access_token': 'account-a', 'refresh_token': 'new'}, 'expiresAt': 1000000}, clock=lambda: 1000)
        self.assertEqual(exc.exception.code, 'auth_expired')
        self.assertEqual(self.saved, [])

    def test_native_check_renews_normally_without_model_or_forced_refresh(self):
        options = []
        self.codex.resolve_codex_runtime_credentials = lambda **kw: options.append(kw) or {'api_key': 'PRIVATE-TOKEN'}
        result = self.helper.check_login(self.auth, self.codex, self.principal, self.home, False)
        self.assertEqual(result['state'], 'saved_login_ready')
        self.assertEqual(result['credentialScope'], 'shared_default')
        self.assertEqual(options, [{'refresh_if_expiring': True}])
        self.assertNotIn('PRIVATE-', json.dumps(result))

    def test_independent_pool_accounts_cannot_be_silently_replaced(self):
        self.store['credential_pool']['openai-codex'] = [
            {'source': 'manual:device_code', 'access_token': 'account-a', 'refresh_token': 'old'}]
        with self.assertRaises(Exception) as exc:
            self.helper.save_login(self.auth, self.codex, self.principal, self.home,
                {'tokens': {'access_token': 'account-b', 'refresh_token': 'new'}, 'expiresAt': 1100000}, clock=lambda: 1000)
        self.assertEqual(exc.exception.code, 'auth_unsupported')
        self.assertEqual(self.saved, [])

    def test_native_adoption_reports_new_saved_scope(self):
        self.root['providers'].clear()
        def resolver(**kwargs):
            self.store['providers']['openai-codex'] = {'tokens': {'access_token': 'account-b', 'refresh_token': 'new'}}
            return {'api_key': 'PRIVATE-TOKEN'}
        self.codex.resolve_codex_runtime_credentials = resolver
        result = self.helper.check_login(self.auth, self.codex, self.principal, self.home, False)
        self.assertEqual(result['credentialScope'], 'profile')

    def test_native_device_flow_only_emits_private_tokens_and_code(self):
        events = []
        codex = SimpleNamespace(CODEX_OAUTH_CLIENT_ID='native-client',
            _codex_request_device_code=lambda *args: {'user_code': 'ABCD-EFGH', 'device_auth_id': 'PRIVATE-DEVICE', 'interval': 3, 'expires_in': 60},
            _codex_poll_authorization_code=lambda *args, **kw: {'authorization_code': 'PRIVATE-AUTH-CODE'},
            _codex_exchange_authorization_code=lambda *args: {'access_token': 'PRIVATE-ACCESS', 'refresh_token': 'PRIVATE-REFRESH'})
        self.helper.run_device(codex, events.append)
        self.assertEqual(events[0], {'type': 'device', 'userCode': 'ABCD-EFGH', 'expiresIn': 60, 'pollIntervalMs': 3000})
        self.assertEqual(events[1]['type'], 'tokens')
        self.assertNotIn('PRIVATE-DEVICE', json.dumps(events))
        self.assertNotIn('PRIVATE-AUTH-CODE', json.dumps(events))


class PrivateProcessTests(unittest.TestCase):
    def setUp(self):
        from hermes_openai_auth import NativeAuthBackend
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for package in ('hermes_cli', 'agent'):
            (self.root / package).mkdir()
            (self.root / package / '__init__.py').write_text('')
        (self.root / 'hermes_cli' / 'auth.py').write_text('')
        (self.root / 'agent' / 'credential_pool.py').write_text('def _codex_principal_identity(token): return None\n')
        self.backend = NativeAuthBackend(self.root / 'home', lambda: self.root, True)

    def tearDown(self):
        self.backend.close()
        self.tmp.cleanup()

    def write_device(self, wait=False):
        (self.root / 'hermes_cli' / 'auth_codex.py').write_text(
            'import os, time\n'
            'print("RAW-SECRET-PRINT", flush=True)\n'
            'os.write(2, b"RAW-SECRET-STDERR")\n'
            'CODEX_OAUTH_CLIENT_ID = "fixture-client"\n'
            'def _codex_request_device_code(*args):\n'
            '    print("RAW-DEVICE-PRINT", flush=True)\n'
            '    return {"user_code":"ABCD-EFGH", "device_auth_id":"RAW-PRIVATE-ID", "interval":3}\n'
            'def _codex_poll_authorization_code(*args, **kwargs):\n'
            + ('    time.sleep(60)\n' if wait else '') +
            '    return {"authorization_code":"RAW-PRIVATE-AUTH"}\n'
            'def _codex_exchange_authorization_code(*args):\n'
            '    return {"access_token":"fixture-access", "refresh_token":"fixture-refresh"}\n')

    def test_native_prints_and_stderr_never_enter_private_protocol(self):
        self.write_device()
        events, done = [], threading.Event()
        def receive(event):
            events.append(event)
            if event.get('type') in {'tokens', 'error'}:
                done.set()
        handle = self.backend.start(receive)
        self.assertTrue(done.wait(3), 'Fixture helper did not finish')
        handle.cancel()
        self.assertEqual([event['type'] for event in events], ['device', 'tokens'])
        self.assertNotIn('RAW-', json.dumps(events))

    def test_close_terminates_only_private_helper_wait(self):
        self.write_device(wait=True)
        ready = threading.Event()
        handle = self.backend.start(lambda event: ready.set() if event.get('type') == 'device' else None)
        self.assertTrue(ready.wait(3), 'Fixture helper did not issue its code')
        start = time.monotonic()
        self.backend.close()
        self.assertLess(time.monotonic() - start, 3)
        self.assertIsNotNone(handle.process.poll())


if __name__ == '__main__':
    unittest.main()
