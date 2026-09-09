"""Profile-local setup around Hermes configuration, with write-only credentials."""
import copy
import hashlib
import json
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

_lock = threading.Lock()

class ProviderError(Exception):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _url(value):
    if not isinstance(value, str): raise ProviderError('Enter an API base URL.')
    parsed = urllib.parse.urlsplit(value.strip())
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ProviderError('Use a base URL without credentials, query parameters or fragments.')
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', '::1')):
        raise ProviderError('Use HTTPS, or HTTP for a local endpoint.')
    return value.strip().rstrip('/')


def _models(entry):
    raw = entry.get('models', [])
    values = list(raw) if isinstance(raw, dict) else raw if isinstance(raw, list) else []
    return list(dict.fromkeys([m for m in [entry.get('model'), entry.get('default_model'), *values] if isinstance(m, str) and m.strip()]))


def _entries(cfg):
    for key, entry in (cfg.get('providers') or {}).items():
        if isinstance(entry, dict): yield 'providers:' + key, key, entry
    for entry in cfg.get('custom_providers') or []:
        if isinstance(entry, dict) and entry.get('name'):
            name = entry['name'].lower().replace(' ', '-')
            yield 'custom:' + name, name, entry


def _secret(entry):
    from hermes_cli.config import get_env_value
    env_key = entry.get('key_env') or entry.get('api_key_env')
    return (get_env_value(env_key) if env_key else None) or entry.get('api_key') or ''


def _revision(entry):
    return hashlib.sha256(json.dumps([entry, _secret(entry)], sort_keys=True).encode()).hexdigest()


def _receipts():
    path = Path(os.environ['HERMES_HOME']) / 'olympus-provider-checks.json'
    try: data = json.loads(path.read_text())
    except (OSError, ValueError): data = {}
    return path, data if isinstance(data, dict) else {}


def _remember(identity, entry):
    path, data = _receipts()
    data[identity] = {'revision': _revision(entry), 'testedAt': int(time.time() * 1000)}
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.olympus-providers-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def _has_pool(url, name):
    from agent.credential_pool import get_custom_provider_pool_key
    from hermes_cli.auth import read_credential_pool
    keys = {'custom:' + str(name).lower().replace(' ', '-')}
    resolved = get_custom_provider_pool_key(url, provider_name=name)
    if resolved: keys.add(resolved)
    return any(read_credential_pool(key) for key in keys)


def _editable(entry):
    return (entry.get('enabled') is not False and (entry.get('api_mode') or 'chat_completions') in ('chat_completions', 'chat-completions')
            and not any(entry.get(field) for field in ('extra_headers', 'headers', 'key_cmd', 'extra_body', 'transport', 'apiKey', 'keyEnv', 'apiKeyEnv', 'credential_pool')))


def _is_default(cfg, slug, entry):
    from hermes_cli.auth import PROVIDER_REGISTRY
    default = str((cfg.get('model') or {}).get('provider') or '').lower()
    name = str(entry.get('name') or slug).lower().replace(' ', '-')
    return default in ('custom:' + slug, 'custom:' + name) or (default not in PROVIDER_REGISTRY and default in (slug, name))


def _list(cfg):
    _, receipts = _receipts()
    rows = []
    for identity, slug, entry in _entries(cfg):
        try: url = _url(entry.get('base_url') or entry.get('url') or entry.get('api'))
        except ProviderError: continue  # Never project credential-bearing URL fields.
        revision = _revision(entry)
        receipt = receipts.get(identity) or {}
        provider = 'custom:' + str(entry.get('name') or slug).lower().replace(' ', '-')
        editable = _editable(entry) and not _has_pool(url, entry.get('name') or slug)
        rows.append({'id': identity, 'name': entry.get('name') or slug, 'provider': provider,
                     'baseUrl': url, 'models': _models(entry), 'hasKey': bool(_secret(entry)),
                     'revision': revision, 'connected': editable and receipt.get('revision') == revision,
                     'testedAt': receipt.get('testedAt') if editable and receipt.get('revision') == revision else None,
                     'isDefault': _is_default(cfg, slug, entry), 'editable': editable})
    return {'providers': rows}


def _find(cfg, request):
    identity = request.get('id')
    if not identity: return None
    matches = [(key, entry) for rid, key, entry in _entries(cfg) if rid == identity]
    if len(matches) != 1: raise ProviderError('Provider changed or is unavailable. Refresh Providers.')
    key, entry = matches[0]
    if request.get('revision') != _revision(entry): raise ProviderError('Provider changed. Refresh before saving.')
    if not _editable(entry) or _has_pool(entry.get('base_url') or entry.get('url') or entry.get('api'), entry.get('name') or key):
        raise ProviderError('This connection has advanced settings that this editor cannot safely change.')
    return key, entry


def _request(url, key, payload=None):
    headers = {'Accept': 'application/json'}
    headers['Authorization'] = 'Bearer ' + (key or 'no-key-required')
    body = None if payload is None else json.dumps(payload).encode()
    if body: headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(url, data=body, headers=headers)
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            raw = response.read(2_000_001)
            if len(raw) > 2_000_000: raise ProviderError('Provider response was too large.')
            result = json.loads(raw)
            if not isinstance(result, dict): raise ProviderError('Provider returned an unsupported response.')
            return result
    except urllib.error.HTTPError as error:
        error.close()
        if error.code in (401, 403): raise ProviderError('Provider authentication failed. Check the API key and account access.') from None
        if error.code == 429: raise ProviderError('Provider rate or balance limit reached. Check the account and retry.') from None
        raise ProviderError('Provider rejected the request. Check its base URL and model support.') from None
    except (OSError, ValueError):
        raise ProviderError('Could not reach the provider or read its response. Check the base URL and retry.') from None


def _connection(request, existing):
    from hermes_cli.auth import has_usable_secret
    url = _url(request.get('baseUrl'))
    key = request.get('apiKey')
    if key is not None and (not isinstance(key, str) or len(key) > 4096 or re.search(r'[\s\x00-\x20\x7f-\uffff\x22\x27#$`\\]', key)):
        raise ProviderError('Enter an API key without whitespace or environment-file syntax.')
    if not key and existing:
        old_url = _url(existing.get('base_url') or existing.get('url') or existing.get('api'))
        if url != old_url: raise ProviderError('Enter the API key again when changing the endpoint.')
        key = _secret(existing)
    if key and not has_usable_secret(key):
        raise ProviderError('Enter a valid API key. Hermes does not accept short or placeholder keys.')
    if not key and urllib.parse.urlsplit(url).hostname not in ('localhost', '127.0.0.1', '::1'):
        raise ProviderError('Enter an API key for a remote endpoint. Only local endpoints can use a blank key.')
    return url, key or ''


def _catalog(url, key):
    result = _request(url + '/models', key)
    data = result.get('data')
    if not isinstance(data, list): raise ProviderError('The endpoint did not return an OpenAI-compatible model list.')
    models = sorted(set(item['id'] for item in data if isinstance(item, dict) and isinstance(item.get('id'), str) and item['id'].strip()))
    if not models: raise ProviderError('The endpoint returned no models for this connection.')
    return models


def manage(request, mutation_guard):
    """mutation_guard serializes final config writes with task admission/default edits."""
    from hermes_cli.config import load_config, save_config, save_env_value, remove_env_value, get_env_value, is_managed
    with _lock:
        try:
            cfg = load_config()
            action = request.get('action')
            if action == 'list': return _list(cfg)
            if action not in ('discover', 'save', 'remove'): raise ProviderError('Unknown provider action.')
            if action in ('save', 'remove'):
                with mutation_guard():
                    if is_managed(): raise ProviderError('This Hermes installation manages configuration externally.')
            found = _find(cfg, request)
            existing = found[1] if found else None
            if action == 'remove':
                if not existing: raise ProviderError('Select a provider to disconnect.')
            else:
                url, key = _connection(request, existing)
                if _has_pool(url, request.get('name') or (existing or {}).get('name') or ''):
                    raise ProviderError('This endpoint has a Hermes credential pool. Its advanced authentication cannot be edited here.')
                catalog = _catalog(url, key)
                if action == 'discover': return {'models': catalog}
                selected = request.get('models')
                if not isinstance(selected, list) or not selected or any(not isinstance(m, str) or m not in catalog for m in selected):
                    raise ProviderError('Select models returned by this provider.')
                selected = list(dict.fromkeys(selected))
                if found and _is_default(cfg, found[0], existing) and (cfg.get('model') or {}).get('default') not in selected:
                    raise ProviderError('Keep the profile default model selected, or choose another default model first.')
                name = request.get('name')
                if not isinstance(name, str) or (not existing and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9 -]{0,59}', name)):
                    raise ProviderError('Use a provider name with letters, numbers, spaces or hyphens.')
                if existing and name != (existing.get('name') or found[0]):
                    raise ProviderError('Provider names stay fixed so existing tasks keep their routing.')
                for model in selected:
                    answer = _request(url + '/chat/completions', key, {'model': model, 'messages': [{'role': 'user', 'content': 'Reply OK.'}], 'max_tokens': 32, 'stream': False})
                    choices = answer.get('choices')
                    message = choices[0].get('message', {}) if isinstance(choices, list) and choices and isinstance(choices[0], dict) else {}
                    if not (message.get('content') or message.get('reasoning_content')):
                        raise ProviderError('The model did not return a completion. Nothing was saved.')
            with mutation_guard():
                if is_managed(): raise ProviderError('This Hermes installation manages configuration externally.')
                cfg = load_config()  # Keep unrelated updates made while connection testing ran.
                found = _find(cfg, request)
                identity = request.get('id')
                if found:
                    slug, old = found
                    if action == 'save' and _is_default(cfg, slug, old) and (cfg.get('model') or {}).get('default') not in selected:
                        raise ProviderError('Keep the profile default model selected, or choose another default model first.')
                else:
                    slug, old = name.lower().replace(' ', '-'), {}
                    if any(s == slug or str(e.get('name', '')).lower().replace(' ', '-') == slug for _, s, e in _entries(cfg)):
                        raise ProviderError('That provider name already exists. Edit its connection instead.')
                    identity = 'providers:' + slug
                changed = copy.deepcopy(cfg)
                if action == 'remove':
                    if _is_default(cfg, slug, old):
                        raise ProviderError('Choose another profile default before disconnecting this provider.')
                    if identity.startswith('providers:'): del changed['providers'][slug]
                    else: changed['custom_providers'] = [e for e in changed['custom_providers'] if e != old]
                    env_key = old.get('key_env') or ''
                    # Never remove a shared or externally managed credential.
                    owns_key = env_key.startswith('OLYMPUS_PROVIDER_') and env_key not in json.dumps(changed)
                    secret_before = get_env_value(env_key) if owns_key else None
                    try:
                        if owns_key: remove_env_value(env_key)
                        save_config(changed)
                        if any(rid == identity for rid, _, _ in _entries(load_config())):
                            raise ProviderError('Hermes did not disconnect this provider. Check managed configuration settings.')
                    except Exception:
                        if secret_before: save_env_value(env_key, secret_before)
                        raise
                else:
                    env_key = 'OLYMPUS_PROVIDER_' + hashlib.sha256(identity.encode()).hexdigest()[:20].upper() + '_API_KEY'
                    previous_key = get_env_value(env_key)
                    entry = {**old, 'name': name, 'base_url': url, 'key_env': env_key,
                             'api_mode': 'chat_completions', 'discover_models': False,
                             'models': {m: (old.get('models', {}).get(m, {}) if isinstance(old.get('models'), dict) else {}) for m in selected}}
                    for field in ('api_key', 'api_key_env', 'api', 'url', 'model', 'default_model'): entry.pop(field, None)
                    if identity.startswith('providers:'): changed.setdefault('providers', {})[slug] = entry
                    else: changed['custom_providers'] = [entry if e == old else e for e in changed['custom_providers']]
                    try:
                        if key: save_env_value(env_key, key)
                        else: remove_env_value(env_key)
                        save_config(changed)
                        persisted = next((e for rid, _, e in _entries(load_config()) if rid == identity), None)
                        if persisted is None or _has_pool(url, name) or _secret(persisted) != key or any(persisted.get(field) != entry.get(field) for field in ('name', 'enabled', 'base_url', 'key_env', 'api_mode', 'discover_models', 'models')):
                            save_config(cfg)
                            raise ProviderError('Hermes did not save the tested connection. Check managed configuration settings.')
                    except Exception:
                        if previous_key is None: remove_env_value(env_key)
                        else: save_env_value(env_key, previous_key)
                        raise
                    _remember(identity, entry)
                return _list(changed)
        except ProviderError: raise
        except Exception:
            # Upstream exceptions/configuration can contain credentials. Never project them.
            raise ProviderError('Provider setup failed. Refresh the connection and try again.') from None
