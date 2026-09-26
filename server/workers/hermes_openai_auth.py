"""Cached OpenAI sign-in state and a private, cancellable native-auth subprocess."""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import uuid

from hermes_worker_utils import WorkerError

VERIFICATION_URL = 'https://auth.openai.com/codex/device'
SAFE_CODES = frozenset({
    'openai_auth_required', 'openai_auth_unavailable', 'auth_busy', 'auth_session_invalid',
    'auth_cancelled', 'auth_expired', 'auth_account_mismatch', 'auth_incomplete_credentials',
    'auth_storage_failed', 'auth_unsupported',
})
TERMINAL = frozenset({'saved', 'cancelled', 'expired', 'failed'})
MAX_PRIVATE_BYTES = 128 * 1024


def safe_code(value, fallback='openai_auth_unavailable'):
    return value if isinstance(value, str) and value in SAFE_CODES else fallback


def auth_error(code):
    return WorkerError('OpenAI sign-in could not be completed.', code=safe_code(code))


def _schedule(seconds, callback):
    timer = threading.Timer(seconds, callback)
    timer.daemon = True
    timer.start()
    return timer


class _DeviceProcess:
    def __init__(self, process, callback, finished):
        self.process = process
        self.callback = callback
        self.finished = finished
        threading.Thread(target=self._read, daemon=True, name='openai-device-auth').start()

    def _read(self):
        completed = False
        try:
            while True:
                line = self.process.stdout.readline(MAX_PRIVATE_BYTES + 1)
                if not line:
                    break
                if len(line) > MAX_PRIVATE_BYTES:
                    raise ValueError('oversized private event')
                event = json.loads(line)
                if not isinstance(event, dict):
                    raise ValueError('invalid private event')
                self.callback(event)
                if event.get('type') in {'tokens', 'error'}:
                    completed = True
                    break
        except Exception:
            pass
        finally:
            if not completed:
                self.callback({'type': 'error', 'code': 'openai_auth_unavailable'})
            self.cancel()
            self.process.stdout.close()
            self.finished(self.process)

    def cancel(self):
        if self.process.poll() is None:
            self.process.terminate()
            # This is an auth-only helper, never the task worker or an agent run.
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()


class NativeAuthBackend:
    def __init__(self, hermes_home, agent_dir, is_default):
        self.home = Path(hermes_home)
        self.agent_dir = agent_dir
        self.is_default = is_default
        self.lock = threading.Lock()
        self.processes = set()
        self.closed = False

    def _spawn(self, action):
        env = {**os.environ, 'HERMES_HOME': str(self.home),
               'OLYMPUS_OPENAI_AUTH_DEFAULT': '1' if self.is_default else '0'}
        with self.lock:
            if self.closed:
                raise auth_error('openai_auth_unavailable')
            process = subprocess.Popen(
                [sys.executable, str(Path(__file__).with_name('hermes_openai_auth_helper.py')),
                 action, str(self.agent_dir())],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                env=env, text=True,
            )
            self.processes.add(process)
            return process

    def _finished(self, process):
        with self.lock:
            self.processes.discard(process)

    def close(self):
        with self.lock:
            self.closed = True
            processes = list(self.processes)
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait()
            self._finished(process)

    def start(self, callback):
        process = self._spawn('device')
        process.stdin.close()
        return _DeviceProcess(process, callback, self._finished)

    def _call(self, action, payload=None):
        process = self._spawn(action)
        try:
            output, _ = process.communicate(json.dumps(payload or {}), timeout=90)
            if len(output) > MAX_PRIVATE_BYTES:
                raise ValueError('oversized private result')
            result = json.loads(output)
            if not isinstance(result, dict) or process.returncode:
                raise ValueError('invalid private result')
            if result.get('type') == 'error':
                raise auth_error(result.get('code'))
            return result
        except WorkerError:
            raise
        except Exception:
            raise auth_error('auth_storage_failed' if action == 'save' else 'openai_auth_unavailable') from None
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            self._finished(process)

    def check(self):
        return self._call('check')

    def save(self, tokens, expires_at):
        self._call('save', {'tokens': tokens, 'expiresAt': expires_at})


class OpenAIAuthManager:
    def __init__(self, *, hermes_home, agent_dir, is_default, commit_guard,
                 on_saved=lambda: None, native=None, clock=time.time, schedule=_schedule):
        self.native = native or NativeAuthBackend(hermes_home, agent_dir, is_default)
        self.is_default = is_default
        self.commit_guard = commit_guard
        self.on_saved = on_saved
        self.clock = clock
        self.schedule = schedule
        self.lock = threading.RLock()
        self.native_lock = threading.Lock()
        self.status = {'provider': 'openai-codex', 'state': 'unknown', 'checkedAt': None,
                       'credentialScope': 'unknown', 'code': None}
        self.session = None
        self.tokens = None
        self.helper = None
        self.timer = None
        self.closed = False

    def _response(self):
        return {'status': dict(self.status), 'session': dict(self.session) if self.session else None}

    def _terminal(self, state, code=None):
        self.session.update(state=state, code=code, userCode=None, verificationUrl=None)
        self.tokens = None
        if self.timer:
            self.timer.cancel()
            self.timer = None
        helper, self.helper = self.helper, None
        if helper:
            helper.cancel()

    def _expire(self, sid):
        with self.lock:
            if self.session and self.session['sessionId'] == sid and self.session['state'] not in TERMINAL:
                if self.clock() * 1000 >= self.session['expiresAt']:
                    self._terminal('expired', 'auth_expired')

    def _deadline(self, sid, seconds):
        if self.timer:
            self.timer.cancel()
        self.session['expiresAt'] = int((self.clock() + seconds) * 1000)
        self.timer = self.schedule(seconds, lambda: self._expire(sid))

    def _event(self, sid, event):
        with self.lock:
            if not self.session or self.session['sessionId'] != sid or self.session['state'] in TERMINAL:
                return
            self._expire(sid)
            if self.session['state'] in TERMINAL:
                return
            kind = event.get('type')
            if kind == 'device' and self.session['state'] == 'starting':
                code = event.get('userCode')
                expires = event.get('expiresIn', 900)
                interval = event.get('pollIntervalMs', 5000)
                if (not isinstance(code, str) or not re.fullmatch(r'[A-Za-z0-9-]{4,32}', code)
                        or type(expires) not in (int, float) or not math.isfinite(expires) or expires <= 0
                        or type(interval) not in (int, float) or not math.isfinite(interval)):
                    self._terminal('failed', 'openai_auth_unavailable')
                    return
                self.session.update(state='awaiting_user', verificationUrl=VERIFICATION_URL,
                                    userCode=code, pollIntervalMs=int(max(3000, min(interval, 60000))))
                self._deadline(sid, min(expires, 900))
            elif kind == 'tokens' and self.session['state'] == 'awaiting_user':
                tokens = event.get('tokens')
                if not isinstance(tokens, dict) or any(
                    not isinstance(tokens.get(key), str) or not tokens[key].strip()
                    for key in ('access_token', 'refresh_token')
                ):
                    self._terminal('failed', 'auth_incomplete_credentials')
                    return
                self.tokens = {key: tokens[key] for key in ('access_token', 'refresh_token', 'id_token')
                               if isinstance(tokens.get(key), str)}
                self.session.update(state='waiting_for_idle', userCode=None, verificationUrl=None)
            elif kind == 'error':
                code = safe_code(event.get('code'))
                self._terminal('expired' if code == 'auth_expired' else 'failed', code)

    def handle(self, request):
        action = request.get('action')
        if action == 'check':
            return self._check()
        with self.lock:
            if action == 'status':
                return self._response()  # No native/store access, including at cold startup.
            if action == 'invalidate':
                self.status.update(state='unknown', checkedAt=None, code=None)
                return self._response()
            if action == 'start':
                if self.closed:
                    raise auth_error('openai_auth_unavailable')
                if self.session:
                    self._expire(self.session['sessionId'])
                    if self.session['state'] not in TERMINAL:
                        return self._response()
                sid = uuid.uuid4().hex
                self.session = {'sessionId': sid, 'state': 'starting', 'verificationUrl': None,
                                'userCode': None, 'expiresAt': None, 'pollIntervalMs': 5000, 'code': None}
                self._deadline(sid, 300)  # Bounds device-code request retries, not agent work.
                try:
                    self.helper = self.native.start(lambda event: self._event(sid, event))
                except Exception:
                    self._terminal('failed', 'openai_auth_unavailable')
                return self._response()
            if action not in {'poll', 'cancel', 'commit'}:
                raise auth_error('auth_unsupported')
            if not self.session or request.get('sessionId') != self.session['sessionId']:
                raise auth_error('auth_session_invalid')
            self._expire(self.session['sessionId'])
            if self.session['state'] in TERMINAL:
                return self._response()
            if action == 'cancel':
                self._terminal('cancelled', 'auth_cancelled')
            elif action == 'commit' and self.session['state'] == 'waiting_for_idle':
                self._commit()
            return self._response()

    def _check(self):
        # Serialize native checks with commit, without blocking cache/status/cancel.
        with self.native_lock:
            try:
                result = self.native.check()
                state = result.get('state')
                scope = result.get('credentialScope')
                if state not in {'not_configured', 'saved_login_ready', 'reconnect_required', 'temporarily_unavailable'}:
                    raise ValueError('invalid private status')
                if scope not in {'profile', 'shared_default', 'none', 'unknown'}:
                    raise ValueError('invalid private scope')
                status = {'provider': 'openai-codex', 'state': state, 'credentialScope': scope,
                          'checkedAt': int(self.clock() * 1000),
                          'code': safe_code(result.get('code')) if result.get('code') else None}
            except Exception as exc:
                status = {**self.status, 'state': 'temporarily_unavailable',
                          'checkedAt': int(self.clock() * 1000), 'code': safe_code(getattr(exc, 'code', None))}
            with self.lock:
                self.status = status
                return self._response()

    def _commit(self):
        if not self.native_lock.acquire(blocking=False):
            return
        try:
            with self.commit_guard():
                self._expire(self.session['sessionId'])
                if self.session['state'] != 'waiting_for_idle':
                    return
                self.native.save(self.tokens, self.session['expiresAt'])
            self.status.update(state='saved_login_ready', checkedAt=int(self.clock() * 1000),
                               credentialScope='shared_default' if self.is_default else 'profile', code=None)
            self._terminal('saved')
            try:
                self.on_saved()
            except Exception:
                pass  # A cache invalidation failure must not misreport a completed native save.
        except Exception as exc:
            code = safe_code(getattr(exc, 'code', None), 'auth_storage_failed')
            if code != 'auth_busy':
                if code == 'auth_storage_failed':
                    self.status.update(state='unknown', checkedAt=None, code=code)
                self._terminal('expired' if code == 'auth_expired' else 'failed', code)
        finally:
            self.native_lock.release()

    def close(self):
        self.closed = True
        # A commit holds the manager lock while its native save runs. Stop that
        # auth-only process first so shutdown cannot wait behind its RPC timeout.
        close = getattr(self.native, 'close', None)
        if callable(close):
            close()
        with self.lock:
            if self.session and self.session['state'] not in TERMINAL:
                self._terminal('cancelled', 'auth_cancelled')
