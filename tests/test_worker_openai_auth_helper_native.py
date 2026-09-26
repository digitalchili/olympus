"""Explicit candidate contract: python THIS_FILE HERMES_SOURCE. All homes are fixtures."""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import time
from unittest.mock import patch


source = str(Path(sys.argv[1]).resolve())
workers = str(Path(__file__).resolve().parents[1] / 'server' / 'workers')


def jwt(account, subject='person'):
    claims = {'sub': subject, 'exp': time.time() + 7200,
              'https://api.openai.com/auth': {'chatgpt_account_id': account}}
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
    return 'fixture.' + payload + '.unsigned'


with tempfile.TemporaryDirectory(prefix='olympus-auth-helper-native-') as temp:
    root = Path(temp)
    home = root / '.hermes'
    profile = home / 'profiles' / 'work'
    profile.mkdir(parents=True)
    guard = root / 'network_guard'
    guard.mkdir()
    (guard / 'sitecustomize.py').write_text(
        'import socket\n'
        'def denied(*a, **kw): raise AssertionError("Network forbidden in auth fixture")\n'
        'socket.socket.connect = denied\nsocket.create_connection = denied\n')
    env = {'HOME': str(root), 'LOCALAPPDATA': str(root), 'HERMES_HOME': str(profile),
           'CODEX_HOME': str(root / 'codex-fixture'), 'PYTHONPATH': str(guard),
           'HERMES_IN_DOCKER': '1'}
    with patch.dict(os.environ, env), patch.object(Path, 'home', return_value=root), \
            patch.object(socket.socket, 'connect', side_effect=AssertionError('Network forbidden')):
        sys.path[:0] = [workers, source]
        from hermes_cli import auth, auth_codex
        from agent.credential_pool import _codex_principal_identity
        from hermes_openai_auth_helper import check_login, save_login
        from hermes_openai_auth import NativeAuthBackend

        root_tokens = {'access_token': jwt('shared-account'), 'refresh_token': 'fixture-root-refresh'}
        root_store = {'version': 1, 'active_provider': 'anthropic', 'providers': {
            'openai-codex': {'tokens': root_tokens, 'auth_mode': 'chatgpt'}}}
        (home / 'auth.json').write_text(json.dumps(root_store))
        (profile / 'auth.json').write_text(json.dumps({'version': 1, 'active_provider': 'deepseek', 'providers': {}}))
        (profile / 'config.yaml').write_text('model:\n  provider: deepseek\n  default: fixture-model\n')
        config_before = (profile / 'config.yaml').read_bytes()
        root_before = (home / 'auth.json').read_bytes()

        result = check_login(auth, auth_codex, _codex_principal_identity, profile, False)
        assert result == {'state': 'saved_login_ready', 'credentialScope': 'shared_default', 'code': None}, result
        assert not (profile / 'olympus-openai-auth.json').exists(), 'Inherited account must not become profile-owned metadata'
        assert 'fixture-root-refresh' not in json.dumps(result)

        backend = NativeAuthBackend(profile, lambda: Path(source), False)
        profile_tokens = {'access_token': jwt('separate-account'), 'refresh_token': 'fixture-profile-refresh'}
        backend.save(profile_tokens, (time.time() + 300) * 1000)
        saved = json.loads((profile / 'auth.json').read_text())
        assert saved['active_provider'] == 'deepseek'
        assert saved['providers']['openai-codex']['tokens'] == profile_tokens
        assert (home / 'auth.json').read_bytes() == root_before
        assert (profile / 'config.yaml').read_bytes() == config_before
        checked = backend.check()
        assert checked == {'state': 'saved_login_ready', 'credentialScope': 'profile', 'code': None}, checked
        assert 'fixture-profile-refresh' not in json.dumps(checked)

        receipt = (profile / 'olympus-openai-auth.json').read_text()
        assert 'separate-account' not in receipt and 'fixture-profile-refresh' not in receipt
        saved['providers'].pop('openai-codex')
        (profile / 'auth.json').write_text(json.dumps(saved))
        assert backend.check() == {'state': 'reconnect_required', 'credentialScope': 'profile', 'code': 'openai_auth_required'}, 'Losing an owned login must not adopt the root account'
        assert 'openai-codex' not in json.loads((profile / 'auth.json').read_text())['providers']
        try:
            backend.save(root_tokens, (time.time() + 300) * 1000)
            raise AssertionError('A different account must be rejected after old token loss')
        except Exception as exc:
            assert getattr(exc, 'code', None) == 'auth_account_mismatch', type(exc).__name__
        assert 'openai-codex' not in json.loads((profile / 'auth.json').read_text())['providers']
        assert (home / 'auth.json').read_bytes() == root_before

print('Native auth helper contract passed with isolated homes and network denied.')
