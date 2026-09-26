"""Private child process: native OpenAI OAuth only; never run an agent/model."""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import time

from hermes_openai_auth import MAX_PRIVATE_BYTES, auth_error, safe_code


def _provider_present(store):
    providers = store.get('providers') or {}
    pools = store.get('credential_pool') or {}
    return isinstance(providers.get('openai-codex'), dict) or bool(pools.get('openai-codex'))


def _own_tokens(store):
    state = (store.get('providers') or {}).get('openai-codex') or {}
    tokens = state.get('tokens')
    return tokens if isinstance(tokens, dict) else {}


def _principal_hash(tokens, principal):
    identity = principal(tokens.get('access_token'))
    if not identity:
        return None
    return hashlib.sha256(json.dumps(list(identity), separators=(',', ':')).encode()).hexdigest()


def _read_receipt(home):
    path = home / 'olympus-openai-auth.json'
    try:
        raw = path.read_text()
        if len(raw) > 1024:
            raise ValueError('oversized identity receipt')
        data = json.loads(raw)
        value = data.get('principalHash')
        if data.get('version') != 1 or not isinstance(value, str) or not re.fullmatch('[0-9a-f]{64}', value):
            raise ValueError('invalid identity receipt')
        return value
    except FileNotFoundError:
        return None
    except Exception:
        raise auth_error('auth_storage_failed') from None


def _write_receipt(home, identity):
    if not identity:
        return
    home.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.olympus-openai-auth-', dir=home)
    try:
        with os.fdopen(fd, 'w') as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump({'version': 1, 'principalHash': identity}, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, home / 'olympus-openai-auth.json')
    except Exception:
        raise auth_error('auth_storage_failed') from None
    finally:
        if os.path.exists(name):
            os.unlink(name)


def _saved_scope(auth, principal, home, is_default):
    with auth._provider_state_transaction('openai-codex') as (store, _, __):
        identity = _principal_hash(_own_tokens(store), principal)
        missing_owned = not identity and bool(_read_receipt(home))
        own = _provider_present(store) or missing_owned
        inherited = not own and _provider_present(auth._load_global_auth_store())
        scope = ('shared_default' if is_default else 'profile') if own else ('shared_default' if inherited else 'none')
        if identity:
            _write_receipt(home, identity)  # Keep account choice if failed refresh later removes tokens.
        return scope, missing_owned


def check_login(auth, codex, principal, home, is_default):
    # Explicit POST may use native store readers/renewal. GET never reaches here.
    scope, missing_owned = _saved_scope(auth, principal, home, is_default)
    if missing_owned:
        return {'state': 'reconnect_required', 'credentialScope': scope, 'code': 'openai_auth_required'}
    try:
        result = codex.resolve_codex_runtime_credentials(refresh_if_expiring=True)
        if not isinstance(result, dict) or not isinstance(result.get('api_key'), str) or not result['api_key'].strip():
            raise auth_error('openai_auth_unavailable')
        scope, missing_owned = _saved_scope(auth, principal, home, is_default)
        return {'state': 'reconnect_required' if missing_owned else 'saved_login_ready',
                'credentialScope': scope, 'code': 'openai_auth_required' if missing_owned else None}
    except Exception as exc:
        relogin = bool(getattr(exc, 'relogin_required', False))
        missing = getattr(exc, 'code', None) == 'codex_auth_missing'
        state = 'not_configured' if missing and scope == 'none' else ('reconnect_required' if relogin else 'temporarily_unavailable')
        return {'state': state, 'credentialScope': scope,
                'code': 'openai_auth_required' if missing or relogin else 'openai_auth_unavailable'}


def save_login(auth, codex, principal, home, payload, clock=time.time):
    tokens = payload.get('tokens')
    if not isinstance(tokens, dict) or any(
        not isinstance(tokens.get(key), str) or not tokens[key].strip()
        for key in ('access_token', 'refresh_token')
    ):
        raise auth_error('auth_incomplete_credentials')
    with auth._provider_state_transaction('openai-codex') as (store, _, __):
        expires = payload.get('expiresAt')
        if type(expires) not in (int, float) or not math.isfinite(expires) or clock() * 1000 >= expires:
            raise auth_error('auth_expired')
        previous = _own_tokens(store).get('access_token')
        entries = (store.get('credential_pool') or {}).get('openai-codex') or []
        # Advanced independently managed accounts keep their native controls.
        # Reconnect supports the singleton and its legacy aliases only.
        for entry in entries:
            if not isinstance(entry, dict) or entry.get('disabled') or not (
                entry.get('source') == 'device_code' or (
                    entry.get('source') == 'manual:device_code' and previous
                    and entry.get('access_token') == previous)):
                raise auth_error('auth_unsupported')
        # Only this home's explicit account is authoritative. A named profile's
        # borrowed root grant is not an explicit choice of its separate account.
        known = _principal_hash(_own_tokens(store), principal) or _read_receipt(home)
        incoming = _principal_hash(tokens, principal)
        if known and incoming != known:
            raise auth_error('auth_account_mismatch')
        # The native lock is reentrant. Keep identity comparison and native write
        # in one transaction, without copying an inherited grant into the profile.
        try:
            codex._save_codex_tokens(tokens, set_active=False, write_through=False)
            _write_receipt(home, incoming)
        except Exception:
            # Native persistence may already have completed. Do not roll credentials
            # back or claim they are unchanged; an explicit check resolves this state.
            raise auth_error('auth_storage_failed') from None


def run_device(codex, emit):
    issuer, client = 'https://auth.openai.com', codex.CODEX_OAUTH_CLIENT_ID
    device = codex._codex_request_device_code(issuer, client)
    expires = device.get('expires_in', 900)
    try:
        expires = min(float(expires), 900)
        interval = max(3, min(int(device.get('interval', 5)), 60))
    except (ValueError, TypeError, OverflowError):
        raise auth_error('openai_auth_unavailable') from None
    if not math.isfinite(expires) or expires <= 0:
        raise auth_error('auth_expired')
    emit({'type': 'device', 'userCode': device.get('user_code'),
          'expiresIn': expires, 'pollIntervalMs': interval * 1000})
    code = codex._codex_poll_authorization_code(issuer, device_auth_id=device['device_auth_id'],
                                               user_code=device['user_code'], poll_interval=interval)
    tokens = codex._codex_exchange_authorization_code(issuer, client, code)
    emit({'type': 'tokens', 'tokens': tokens})  # Private pipe; parent never projects these fields.


def main():
    # Duplicate a private protocol descriptor, then silence all native stdout,
    # stderr and logging at OS level (including cached streams/import-time prints).
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), 'w', buffering=1)
    with open(os.devnull, 'w') as sink:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
    logging.disable(logging.CRITICAL)

    def emit(event):
        protocol.write(json.dumps(event, separators=(',', ':')) + '\n')
        protocol.flush()

    try:
        action, source = sys.argv[1:]
        sys.path.insert(0, source)
        from hermes_cli import auth, auth_codex as codex
        from agent.credential_pool import _codex_principal_identity
        home = Path(os.environ['HERMES_HOME'])
        if action == 'device':
            run_device(codex, emit)
        elif action == 'check':
            emit(check_login(auth, codex, _codex_principal_identity, home,
                             os.environ.get('OLYMPUS_OPENAI_AUTH_DEFAULT') == '1'))
        elif action == 'save':
            raw = sys.stdin.read(MAX_PRIVATE_BYTES + 1)
            if len(raw) > MAX_PRIVATE_BYTES:
                raise auth_error('auth_incomplete_credentials')
            save_login(auth, codex, _codex_principal_identity, home, json.loads(raw))
            emit({'type': 'saved'})
        else:
            raise auth_error('auth_unsupported')
    except (ImportError, AttributeError):
        emit({'type': 'error', 'code': 'auth_unsupported'})
    except Exception as exc:
        code = 'auth_expired' if getattr(exc, 'code', None) == 'device_code_timeout' else safe_code(getattr(exc, 'code', None))
        emit({'type': 'error', 'code': code})
    finally:
        protocol.close()


if __name__ == '__main__':
    main()
