"""Profile provider setup: real HTTP fixture, temporary config, no live credentials."""
import contextlib
import ast
import copy
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server/workers'))
import hermes_providers as providers

class Endpoint(BaseHTTPRequestHandler):
    calls = []
    fail = False
    redirect = False
    def log_message(self, *args): pass
    def send(self, code, body):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        if self.redirect: self.send_header('Location', '/other')
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())
    def do_GET(self):
        self.calls.append(('GET', self.path, self.headers.get('Authorization')))
        self.send(302 if self.redirect else 200, {'data': [{'id': 'model-a'}, {'id': 'model-b'}]})
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.calls.append(('POST', self.path, data))
        self.send(401 if self.fail else 200, {'error': 'private-fixture-key' } if self.fail else {'choices': [{'message': {'content': 'OK'}}]})

class ProviderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Endpoint)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}/v1'
    @classmethod
    def tearDownClass(cls): cls.server.shutdown(); cls.server.server_close()
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = {}
        self.cfg = {'model': {'provider': 'openai-codex', 'default': 'existing'}, 'unrelated': {'keep': True}}
        self.patchenv = patch.dict(os.environ, {'HERMES_HOME': self.temp.name})
        self.patchenv.start()
        def save(cfg): self.cfg = copy.deepcopy(cfg)
        def secret(key, value): self.env[key] = value
        native = SimpleNamespace(load_config=lambda: copy.deepcopy(self.cfg), save_config=save,
            get_env_value=lambda key: self.env.get(key), save_env_value=secret,
            remove_env_value=lambda key: self.env.pop(key, None), is_managed=lambda: False)
        self.native = native
        self.pooled = []
        self.modules = patch.dict(sys.modules, {'hermes_cli.config': native, 'hermes_cli.auth': SimpleNamespace(PROVIDER_REGISTRY={'deepseek': {}, 'openai-codex': {}}, read_credential_pool=lambda key: self.pooled, has_usable_secret=lambda key: len(key) >= 4 and key != 'dummy')})
        self.pool_module = patch.dict(sys.modules, {'agent.credential_pool': SimpleNamespace(get_custom_provider_pool_key=lambda url, provider_name=None: 'custom:' + str(provider_name).lower().replace(' ', '-'))})
        self.pool_module.start()
        self.modules.start()
        Endpoint.calls = []; Endpoint.fail = False; Endpoint.redirect = False
    def tearDown(self): self.modules.stop(); self.pool_module.stop(); self.patchenv.stop(); self.temp.cleanup()
    def run_action(self, action, **values):
        return providers.manage({'action': action, **values}, contextlib.nullcontext)
    def save(self, **values):
        return self.run_action('save', name='Test endpoint', baseUrl=self.url, apiKey='private-fixture-key', models=['model-a'], **values)
    def test_connection_work_does_not_block_jsonl_health(self):
        source = Path(__file__).resolve().parents[1] / 'server/workers/hermes_worker.py'
        tree = ast.parse(source.read_text())
        handler = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_handle_request')
        started, release, finished = threading.Event(), threading.Event(), threading.Event()
        def slow(*args):
            started.set(); release.wait(2); finished.set()
        results = []
        scope = {'Any':object, 'threading':threading, 'sys':sys, '_AGENT_DIR':None,
                 '_handle_provider_request':slow, '_result':lambda key,value: results.append(key)}
        exec(compile(ast.Module(body=[handler], type_ignores=[]), str(source), 'exec'),scope)
        try:
            scope['_handle_request']({'id':'setup','type':'providers.manage','action':'save'})
            self.assertTrue(started.wait(1))
            scope['_handle_request']({'id':'health','type':'health'})
            self.assertEqual(results,['health']); self.assertFalse(finished.is_set())
        finally: release.set(); finished.wait(1)

    def test_discovery_does_not_write_or_test_a_model(self):
        result = self.run_action('discover', name='Test', baseUrl=self.url, apiKey='private-fixture-key')
        self.assertEqual(result['models'], ['model-a', 'model-b'])
        self.assertFalse(self.env)
        self.assertEqual([c[0] for c in Endpoint.calls], ['GET'])
    def test_keyless_connections_are_local_only(self):
        with patch.object(providers, '_catalog', return_value=['model-a']) as catalog:
            with self.assertRaisesRegex(providers.ProviderError, 'API key'):
                self.run_action('discover', name='Remote', baseUrl='https://api.example.com/v1')
            catalog.assert_not_called()
        self.assertEqual(self.run_action('discover', name='Local', baseUrl=self.url)['models'], ['model-a', 'model-b'])
        self.assertEqual(Endpoint.calls[0][2], 'Bearer no-key-required')
    def test_native_unusable_keys_are_rejected_before_connection_test(self):
        for key in ('abc', 'dummy'):
            with self.assertRaisesRegex(providers.ProviderError, 'API key'):
                self.run_action('discover', name='Test', baseUrl=self.url, apiKey=key)
        self.assertFalse(Endpoint.calls)
    def test_save_tests_selected_models_and_preserves_default_and_secrets(self):
        row = self.save()['providers'][0]
        self.assertTrue(row['connected'])
        self.assertNotIn('private-fixture-key', json.dumps(row))
        self.assertEqual(self.cfg['model'], {'provider': 'openai-codex', 'default': 'existing'})
        self.assertTrue(self.cfg['unrelated']['keep'])
        entry = self.cfg['providers']['test-endpoint']
        self.assertNotIn('api_key', entry)
        self.assertEqual(self.env[entry['key_env']], 'private-fixture-key')
        self.assertFalse(entry['discover_models'])
        self.assertEqual(list(entry['models']), ['model-a'])
        request = next(c[2] for c in Endpoint.calls if c[0] == 'POST')
        self.assertEqual(request['model'], 'model-a'); self.assertNotIn('tools', request)
        self.assertTrue(self.run_action('list')['providers'][0]['connected'])
    def test_failed_test_or_unknown_model_does_not_save(self):
        Endpoint.fail = True
        with self.assertRaisesRegex(providers.ProviderError, 'authentication') as caught: self.save()
        self.assertNotIn('private-fixture-key', str(caught.exception))
        self.assertFalse(self.env); self.assertNotIn('providers', self.cfg)
        Endpoint.fail = False
        with self.assertRaises(providers.ProviderError):
            self.run_action('save', name='Unknown', baseUrl=self.url, apiKey='fixture-key', models=['made-up'])
        self.assertFalse(self.env)
    def test_edit_reuses_key_and_refreshes_verified_models(self):
        row = self.save()['providers'][0]
        result = self.run_action('save', id=row['id'], revision=row['revision'], name=row['name'], baseUrl=self.url, models=['model-b'])
        self.assertEqual(result['providers'][0]['models'], ['model-b'])
        self.assertEqual(len(self.env), 1)
        with self.assertRaisesRegex(providers.ProviderError, 'changed'):
            self.run_action('remove', id=row['id'], revision=row['revision'])
    def test_endpoint_change_requires_explicit_key(self):
        row = self.save()['providers'][0]
        with self.assertRaisesRegex(providers.ProviderError, 'key'):
            self.run_action('discover', id=row['id'], revision=row['revision'], name=row['name'], baseUrl=self.url + '/different')
    def test_disconnect_preserves_other_config_and_cannot_remove_default(self):
        row = self.save()['providers'][0]
        self.cfg['model']['provider'] = row['provider']
        with self.assertRaisesRegex(providers.ProviderError, 'default'):
            self.run_action('remove', id=row['id'], revision=row['revision'])
        self.cfg['model']['provider'] = 'openai-codex'
        self.run_action('remove', id=row['id'], revision=row['revision'])
        self.assertFalse(self.env); self.assertTrue(self.cfg['unrelated']['keep'])
    def test_busy_commit_and_config_failure_preserve_existing_secret(self):
        row = self.save()['providers'][0]
        before = copy.deepcopy(self.env)
        @contextlib.contextmanager
        def busy(): raise providers.ProviderError('Profile is busy'); yield
        with self.assertRaisesRegex(providers.ProviderError, 'busy'):
            providers.manage({'action':'save', 'id':row['id'], 'revision':row['revision'], 'name':row['name'], 'baseUrl':self.url, 'models':['model-b'], 'apiKey':'replacement'}, busy)
        self.assertEqual(self.env, before)
        self.native.save_config = lambda cfg: (_ for _ in ()).throw(OSError('private-fixture-key'))
        with self.assertRaises(providers.ProviderError):
            self.run_action('save', id=row['id'], revision=row['revision'], name=row['name'], baseUrl=self.url, models=['model-b'], apiKey='replacement')
        self.assertEqual(self.env, before)
    def test_advanced_auth_cannot_be_forwarded_to_changed_endpoint(self):
        self.cfg['providers'] = {'advanced': {'name':'Advanced', 'base_url': self.url, 'models':['model-a'], 'extra_headers': {'Authorization':'private-fixture-key'}}}
        row = self.run_action('list')['providers'][0]
        self.assertFalse(row['editable'])
        with self.assertRaises(providers.ProviderError):
            self.run_action('save', id=row['id'], revision=row['revision'], name=row['name'], baseUrl=self.url+'/other', apiKey='replacement', models=['model-a'])
        self.assertFalse(Endpoint.calls)

    def test_custom_key_default_alias_and_builtin_precedence(self):
        self.cfg['providers'] = {'endpoint-id': {'name':'My Endpoint', 'base_url':self.url, 'models':['model-a']}}
        self.cfg['model']['provider'] = 'custom:endpoint-id'
        row = self.run_action('list')['providers'][0]
        self.assertTrue(row['isDefault'])
        with self.assertRaisesRegex(providers.ProviderError, 'default'):
            self.run_action('remove', id=row['id'], revision=row['revision'])
        self.cfg['providers'] = {'deepseek': {'name':'DeepSeek', 'base_url':self.url, 'models':['model-a']}}
        self.cfg['model']['provider'] = 'deepseek'
        self.assertFalse(self.run_action('list')['providers'][0]['isDefault'])

    def test_silently_refused_native_secret_write_cannot_claim_connected(self):
        self.native.save_env_value = lambda key, value: None
        with self.assertRaises(providers.ProviderError): self.save()
        self.assertFalse(any(row['connected'] for row in self.run_action('list')['providers']))

    def test_pool_backed_or_disabled_connections_cannot_claim_tested_key(self):
        row = self.save()['providers'][0]
        self.pooled = [{'access_token':'different-pool-key'}]
        self.assertFalse(self.run_action('list')['providers'][0]['editable'])
        with self.assertRaises(providers.ProviderError):
            self.run_action('save', id=row['id'], revision=row['revision'], name=row['name'], baseUrl=self.url, models=['model-b'])
        self.pooled = []
        self.cfg['providers']['test-endpoint']['enabled'] = False
        self.assertFalse(self.run_action('list')['providers'][0]['editable'])

    def test_edit_cannot_remove_current_default_model(self):
        row = self.save()['providers'][0]
        self.cfg['model'] = {'provider':row['provider'], 'default':'model-a'}
        with self.assertRaisesRegex(providers.ProviderError, 'default model'):
            self.run_action('save', id=row['id'], revision=row['revision'], name=row['name'], baseUrl=self.url, models=['model-b'])

    def test_default_change_during_connection_test_is_preserved(self):
        row = self.save()['providers'][0]
        request = providers._request
        def change_default(url, key, payload=None):
            result = request(url, key, payload)
            if payload: self.cfg['model'] = {'provider':row['provider'], 'default':'model-a'}
            return result
        with patch.object(providers, '_request', side_effect=change_default):
            with self.assertRaisesRegex(providers.ProviderError, 'default model'):
                self.run_action('save', id=row['id'], revision=row['revision'], name=row['name'], baseUrl=self.url, models=['model-b'])
        self.assertEqual(list(self.cfg['providers']['test-endpoint']['models']), ['model-a'])

    def test_redirects_and_credential_urls_are_rejected(self):
        Endpoint.redirect = True
        with self.assertRaises(providers.ProviderError):
            self.run_action('discover', name='Test', baseUrl=self.url, apiKey='fixture-key')
        self.assertEqual(len(Endpoint.calls), 1)
        with self.assertRaises(providers.ProviderError):
            self.run_action('discover', name='Test', baseUrl='https://user:secret@example.org/v1', apiKey='key')

if __name__ == '__main__': unittest.main()
