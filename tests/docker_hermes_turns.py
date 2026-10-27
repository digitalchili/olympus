"""Real built worker + Hermes turns, with only provider HTTP replaced by a fixture.

Container-only; all homes are disposable and external networking is disabled.
"""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path('/tmp/hermes-turns-fixture')
HOME = ROOT / 'hermes'
WORKER = '/opt/olympus-dispatch/dist/server/server/workers/hermes_worker.py'
requests = []


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.reply({'object': 'list', 'data': [{'id': 'qa-fixture', 'object': 'model'}]})

    def reply(self, body):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(body)
        message = {'role': 'assistant', 'content': 'HERMES_TURN_OK'}
        choice = {'index': 0, 'message': message, 'finish_reason': 'stop'}
        if body.get('stream'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            for delta, finish in [(message, None), ({}, 'stop')]:
                event = {'id': 'fixture', 'object': 'chat.completion.chunk', 'model': 'qa-fixture',
                         'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
        else:
            self.reply({'id': 'fixture', 'object': 'chat.completion', 'model': 'qa-fixture',
                        'choices': [choice], 'usage': {'prompt_tokens': 100, 'completion_tokens': 5}})


def install_skill(name):
    path = ROOT / 'olympus-skills' / name
    path.mkdir(parents=True)
    (path / 'SKILL.md').write_text(f'---\nname: {name}\ndescription: Harmless upgrade test fixture.\n---\nReply with the fixture marker.\n')


def main():
    HOME.mkdir(parents=True)
    install_skill('olympus-before-upgrade-fixture')
    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{provider.server_port}/v1'
    (HOME / 'config.yaml').write_text(json.dumps({
        'model': {'default': 'qa-fixture', 'provider': 'custom:qa-fixture', 'base_url': url},
        'custom_providers': [{'name': 'qa-fixture', 'base_url': url, 'api_key': 'fixture-only',
                              'api_mode': 'chat_completions', 'model': 'qa-fixture'}],
        'toolsets': ['skills'], 'skills': {'external_dirs': [str(ROOT / 'olympus-skills')]},
        'memory': {'memory_enabled': False, 'user_profile_enabled': False},
    }))
    env = {**os.environ, 'HOME': str(ROOT), 'HERMES_HOME': str(HOME),
           'OLYMPUS_DISPATCH_HOME': str(ROOT / 'olympus'), 'HERMES_AGENT_DIR': '/opt/hermes',
           'PYTHONPATH': '/opt/hermes', 'PYTHONDONTWRITEBYTECODE': '1'}
    events = queue.Queue()
    with (ROOT / 'worker.log').open('w') as log:
        worker = subprocess.Popen([sys.executable, WORKER], env=env, stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=log, text=True)
        def read():
            for line in worker.stdout:
                events.put(json.loads(line))
        threading.Thread(target=read, daemon=True).start()
        try:
            for turn in range(3):
                if turn == 1:
                    install_skill('olympus-installed-during-session-fixture')
                worker.stdin.write(json.dumps({'id': str(turn), 'type': 'chat', 'sessionId': 'upgrade-fixture',
                    'message': f'Fixture turn {turn}; reply with HERMES_TURN_OK without using tools.'}) + '\n')
                worker.stdin.flush()
                text = ''
                while True:
                    event = events.get(timeout=60)
                    if event.get('id') != str(turn):
                        continue
                    assert event['type'] != 'error', event
                    if event['type'] == 'text_delta':
                        text += event['content']
                    if event['type'] == 'done':
                        break
                assert 'HERMES_TURN_OK' in text, 'real worker must stream the fixture response'
            chats = [r['messages'] for r in requests if r.get('tools')]
            assert len(chats) == 3, 'each resumed worker turn must reach the fixture provider once'
            first_prompt = next(m['content'] for m in chats[0] if m['role'] == 'system')
            assert 'olympus-before-upgrade-fixture' in first_prompt
            assert 'only when it carries domain knowledge you lack' in first_prompt
            assert 'even partially relevant' not in first_prompt
            assert 'removing superseded wording' in first_prompt
            assert 'skill_manage' in {t['function']['name'] for t in next(r for r in requests if r.get('tools'))['tools']}
            assert 'olympus-installed-during-session-fixture' not in first_prompt
            resumed_prompt = next(m['content'] for m in chats[1] if m['role'] == 'system')
            assert resumed_prompt == first_prompt, 'native cached system prompt must remain stable'
            for messages in chats[1:]:
                notes = [m for m in messages if m['role'] == 'user' and 'skills available in this conversation changed' in str(m['content'])]
                assert len(notes) == 1, 'skill announcement must survive resume without duplicate announcements'
                assert 'olympus-installed-during-session-fixture' in str(notes[0]['content'])
            print('PASS real built worker: three streamed/resumed turns, mid-session external skill discovery and stable prompt')
        finally:
            worker.stdin.close()
            worker.wait(timeout=15)
            worker.stdout.close()
            provider.shutdown()
            provider.server_close()
            assert worker.returncode == 0


if __name__ == '__main__':
    main()
