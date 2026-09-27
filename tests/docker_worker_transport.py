"""Test-only HTTP transport; native OAuth functions and subprocesses stay real."""
import base64
import json
import os
from pathlib import Path
import socket
import time


def install():
    import httpx
    root = Path('/tmp/worker-fixture')

    def denied(*args, **kwargs):
        raise AssertionError('External networking is forbidden in worker acceptance')

    socket.socket.connect = denied
    socket.create_connection = denied

    def transport(request):
        assert request.url.host == 'auth.openai.com', 'Unexpected provider endpoint'
        path = request.url.path
        with (root / 'oauth-requests').open('a') as log:
            log.write(path + '\n')
        # A native dependency that prints sensitive transport details must not
        # contaminate either public JSONL or the worker's stderr.
        os.write(1, b'SYNTHETIC_PRIVATE_NATIVE_NOISE\n')
        os.write(2, b'SYNTHETIC_PRIVATE_NATIVE_NOISE\n')
        if path == '/api/accounts/deviceauth/usercode':
            return httpx.Response(200, json={
                'device_auth_id': 'fixture-device', 'user_code': 'TEST-CODE',
                'interval': 3, 'expires_in': float((root / 'expires').read_text()),
            })
        if path == '/api/accounts/deviceauth/token':
            body = json.loads(request.content)
            assert body == {'device_auth_id': 'fixture-device', 'user_code': 'TEST-CODE'}
            return httpx.Response(200, json={'authorization_code': 'fixture-code', 'code_verifier': 'fixture-verifier'}) \
                if (root / 'approve').exists() else httpx.Response(404)
        if path == '/oauth/token':
            from urllib.parse import parse_qs
            body = parse_qs(request.content.decode())
            assert body['grant_type'] == ['authorization_code']
            assert body['code'] == ['fixture-code'] and body['code_verifier'] == ['fixture-verifier']
            claims = {'sub': 'fixture-person', 'exp': time.time() + 7200,
                      'https://api.openai.com/auth': {'chatgpt_account_id': 'fixture-account'}}
            payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
            return httpx.Response(200, json={'access_token': 'fixture.' + payload + '.unsigned',
                                           'refresh_token': 'SYNTHETIC_PRIVATE_REFRESH'})
        raise AssertionError('Unexpected OAuth path')

    original = httpx.Client.__init__

    def initialize(self, *args, **kwargs):
        kwargs['transport'] = httpx.MockTransport(transport)
        original(self, *args, **kwargs)

    httpx.Client.__init__ = initialize
