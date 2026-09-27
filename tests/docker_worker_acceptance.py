"""Container-only acceptance: built JSONL worker, native Hermes, fake provider I/O.

Run through docker_worker_acceptance.sh. Never mounts a host profile or credential.
"""
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import threading
import time

ROOT = Path('/tmp/worker-fixture')
WORKERS = Path('/opt/olympus-dispatch/dist/server/server/workers')
SOURCE = Path('/opt/hermes')
HOME = ROOT / 'home' / '.hermes'


def wait_for(predicate, description, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError('Timed out: ' + description)


def child():
    sys.path[:0] = [str(WORKERS), str(SOURCE)]
    import hermes_worker as worker
    # Keep the built protocol output, while native imports use worker stderr.
    sys.stdout = sys.stderr
    from hermes_cli import model_switch

    def inventory(**kwargs):
        with (ROOT / 'catalog-calls').open('a') as output:
            output.write('call\n')
        (ROOT / 'catalog-entered').touch()
        wait_for(lambda: (ROOT / 'catalog-release').exists(), 'catalog release', 30)
        return [{'slug': 'openai-codex', 'name': 'OpenAI', 'models': [kwargs['current_model']]}]

    def fake_turn(rid, request, key):
        # The model turn is a fixture; admission, Stop and JSONL remain production.
        (ROOT / 'chat-admitted').touch()
        wait_for(lambda: key in worker.PENDING_INTERRUPTS, 'explicit Stop', 30)
        with worker.ACTIVE_TASKS_LOCK:
            worker.ACTIVE_TASKS.pop(key, None)
            worker.PENDING_INTERRUPTS.pop(key, None)
        worker._send({'id': rid, 'type': 'done', 'sessionId': key})

    model_switch.list_authenticated_providers = inventory
    worker._run_chat_thread = fake_turn
    sys.argv = [str(WORKERS / 'hermes_worker.py')]
    raise SystemExit(worker.main())


class Worker:
    def __init__(self):
        self.public, self.errors, self.pending = [], [], {}
        self.events = queue.Queue()
        self.process = subprocess.Popen([sys.executable, __file__, '--child'],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True)
        def read():
            for line in self.process.stdout:
                self.public.append(line)
                self.events.put(json.loads(line))
        def errors():
            self.errors.extend(self.process.stderr)
        self.reader = threading.Thread(target=read, daemon=True)
        self.error_reader = threading.Thread(target=errors, daemon=True)
        self.reader.start()
        self.error_reader.start()

    def send(self, rid, kind, **data):
        self.process.stdin.write(json.dumps({'id': rid, 'type': kind, **data}) + '\n')
        self.process.stdin.flush()

    def receive(self, rid, timeout=15):
        deadline = time.monotonic() + timeout
        while rid not in self.pending:
            try:
                event = self.events.get(timeout=max(0.001, deadline - time.monotonic()))
            except queue.Empty:
                raise AssertionError('No worker response for ' + rid) from None
            self.pending[event['id']] = event
        event = self.pending.pop(rid)
        assert event['type'] != 'error', 'Worker returned an error for ' + rid
        return event.get('data', event)

    def call(self, rid, kind, **data):
        self.send(rid, kind, **data)
        return self.receive(rid)

    def auth(self, action, **data):
        return self.call('auth-' + action, 'auth.openai', action=action, **data)

    def session_state(self, sid, expected):
        latest = {}
        def check():
            latest.update(self.auth('poll', sessionId=sid))
            return latest['session']['state'] == expected
        wait_for(check, 'auth ' + expected)
        return latest

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
            raise AssertionError('Worker did not shut down normally') from None
        self.reader.join(2)
        self.error_reader.join(2)
        for pipe in (self.process.stdin, self.process.stdout, self.process.stderr):
            pipe.close()
        assert self.process.returncode == 0, 'Worker did not exit cleanly'
        output = ''.join(self.public + self.errors)
        for secret in ('SYNTHETIC_PRIVATE', 'fixture-verifier', 'fixture-code', 'fixture-device', 'access_token', 'refresh_token'):
            assert secret not in output, 'Private auth data leaked to worker output'


def main():
    HOME.mkdir(parents=True)
    (ROOT / 'codex').mkdir()
    (ROOT / 'transport').mkdir()
    (ROOT / 'transport/sitecustomize.py').write_text('from docker_worker_transport import install\ninstall()\n')
    os.environ['PYTHONPATH'] = str(ROOT / 'transport') + ':/fixtures:' + str(SOURCE)
    os.environ['OLYMPUS_OPENAI_AUTH_SHARED'] = '1'
    (HOME / 'config.yaml').write_text('model:\n  provider: openai-codex\n  default: fixture-model\n')
    (HOME / 'auth.json').write_text(json.dumps({'version': 1, 'active_provider': 'deepseek', 'providers': {}}))
    (HOME / 'auth.json').chmod(0o600)
    worker = Worker()
    try:
        assert worker.call('cold', 'health')['ok']
        worker.send('catalog-a', 'models.list')
        wait_for(lambda: (ROOT / 'catalog-entered').exists(), 'native catalog boundary', 60)
        worker.send('catalog-b', 'models.list')
        started = time.monotonic()
        worker.send('health', 'health')
        assert worker.receive('health', timeout=2)['ok']
        worker.send('settings', 'settings.get')
        assert worker.receive('settings', timeout=2)['model'] == 'fixture-model'
        worker.send('chat', 'chat', sessionId='fixture-task', message='fixture admission only')
        wait_for(lambda: (ROOT / 'chat-admitted').exists(), 'chat admission', 2)
        worker.send('stop', 'chat.interrupt', sessionId='fixture-task')
        assert worker.receive('stop', timeout=2)['interrupted']
        worker.receive('chat', timeout=2)
        assert not (ROOT / 'catalog-release').exists()
        assert 'catalog-a' not in worker.pending and 'catalog-b' not in worker.pending
        print('PASS blocked model inventory: health, settings, chat admission and Stop responded in %.3fs' % (time.monotonic() - started))
        (ROOT / 'catalog-release').touch()
        assert worker.receive('catalog-a') == worker.receive('catalog-b')
        assert (ROOT / 'catalog-calls').read_text().splitlines() == ['call']
        print('PASS concurrent catalog misses coalesced into one native inventory call')

        original_config = (HOME / 'config.yaml').read_bytes()
        original_auth = (HOME / 'auth.json').read_bytes()
        assert worker.auth('status')['status']['state'] == 'unknown'
        assert worker.auth('check')['status']['state'] == 'not_configured'
        (ROOT / 'expires').write_text('60')
        started_auth = worker.auth('start')
        sid = started_auth['session']['sessionId']
        awaiting = worker.session_state(sid, 'awaiting_user')['session']
        assert awaiting['verificationUrl'] == 'https://auth.openai.com/codex/device'
        assert awaiting['userCode'] == 'TEST-CODE'
        assert worker.auth('start')['session']['sessionId'] == sid
        wait_for(lambda: '/api/accounts/deviceauth/token' in (ROOT / 'oauth-requests').read_text(), 'native pending poll')
        (ROOT / 'approve').touch()
        worker.session_state(sid, 'waiting_for_idle')
        assert (HOME / 'auth.json').read_bytes() == original_auth
        assert worker.auth('commit', sessionId=sid)['session']['state'] == 'waiting_for_idle', 'unguarded save must wait'
        assert worker.auth('guard', enabled=True) == {'guarded': True, 'activeRuns': 0}
        assert worker.auth('commit', sessionId=sid)['session']['state'] == 'saved'
        worker.auth('guard', enabled=False)
        assert worker.auth('check')['status']['state'] == 'saved_login_ready'
        saved = json.loads((HOME / 'auth.json').read_text())
        assert saved['active_provider'] == 'deepseek'
        assert saved['providers']['openai-codex']['tokens']['refresh_token'] == 'SYNTHETIC_PRIVATE_REFRESH'
        assert (HOME / 'config.yaml').read_bytes() == original_config
        assert (HOME / 'auth.json').stat().st_mode & 0o777 == 0o600
        print('PASS native device request/pending poll/exchange, private helper, guarded save and explicit check; defaults unchanged')

        saved_auth = (HOME / 'auth.json').read_bytes()
        (ROOT / 'approve').unlink()
        sid = worker.auth('start')['session']['sessionId']
        worker.session_state(sid, 'awaiting_user')
        assert worker.auth('cancel', sessionId=sid)['session']['state'] == 'cancelled'
        (ROOT / 'expires').write_text('0.3')
        sid = worker.auth('start')['session']['sessionId']
        worker.session_state(sid, 'expired')
        assert (HOME / 'auth.json').read_bytes() == saved_auth
        assert worker.call('still-alive', 'health')['ok']
        print('PASS cancelled/expired attempts preserve saved credentials and worker liveness')
    finally:
        worker.close()
    print('PASS no private token or native transport output in public JSONL/stderr')

    # Reuse the existing native suites against the image's source and built helper.
    # The helper suite resolves ../server/workers, so link that fixture path to the
    # immutable built assets rather than copying source worker files into the test.
    native = ROOT / 'native'
    (native / 'tests').mkdir(parents=True)
    (native / 'server').mkdir()
    (native / 'server/workers').symlink_to(WORKERS)
    native_env = dict(os.environ)
    native_env.pop('PYTHONPATH', None)
    for name in ('test_worker_openai_auth_native.py', 'test_worker_openai_auth_helper_native.py'):
        shutil.copyfile(Path('/fixtures') / name, native / 'tests' / name)
        subprocess.run([sys.executable, str(native / 'tests' / name), str(SOURCE)], env=native_env, check=True, timeout=60)
    print('Built worker SHA256: ' + hashlib.sha256((WORKERS / 'hermes_worker.py').read_bytes()).hexdigest())
    print('PASS container worker/auth acceptance; no external networking or model requests')


if __name__ == '__main__':
    if '--child' in sys.argv:
        child()
    else:
        main()
