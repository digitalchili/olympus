import sys
import unittest
import ast
import threading
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server' / 'workers'))
import hermes_usage
from hermes_usage import project_usage, get_usage


class UsageTests(unittest.TestCase):
    def test_usage_lookup_does_not_block_worker_health(self):
        source = Path(__file__).resolve().parents[1] / 'server' / 'workers' / 'hermes_worker.py'
        tree = ast.parse(source.read_text())
        handler = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_handle_request')
        started, release, finished = threading.Event(), threading.Event(), threading.Event()
        def slow_usage(*args):
            started.set()
            release.wait(2)
            finished.set()
        results = []
        scope = {'Any': object, 'threading': threading, 'sys': sys, '_AGENT_DIR': None,
                 '_handle_usage_request': slow_usage, '_result': lambda key, value: results.append((key, value))}
        exec(compile(ast.Module(body=[handler], type_ignores=[]), str(source), 'exec'), scope)
        try:
            scope['_handle_request']({'id': 'usage', 'type': 'usage.get'})
            self.assertTrue(started.wait(1))
            scope['_handle_request']({'id': 'health', 'type': 'health'})
            self.assertEqual(results[0][0], 'health')
            self.assertFalse(finished.is_set())
        finally:
            release.set()
            finished.wait(1)

    def test_connected_inventory_order_cache_and_refresh(self):
        calls = []
        native = SimpleNamespace(fetch_account_usage=lambda provider: calls.append(provider))
        inventory = SimpleNamespace(list_authenticated_providers=lambda **kwargs: [
            {'slug': 'anthropic', 'name': 'Anthropic', 'api_key': 'private'},
            {'slug': 'openai-codex', 'name': 'OpenAI'},
            {'slug': 'openai', 'name': 'OpenAI API'},
        ])
        config = SimpleNamespace(get_compatible_custom_providers=lambda cfg: [])
        hermes_usage._cached = None
        with patch.dict(sys.modules, {'agent.account_usage': native, 'hermes_cli.model_switch': inventory, 'hermes_cli.config': config}):
            result = get_usage({'provider': 'openai-codex'}, {})
            self.assertEqual(result['providers'][0]['provider'], 'openai-codex')
            self.assertEqual(set(calls), {'anthropic', 'openai-codex'})
            self.assertNotIn('private', str(result))
            get_usage({'provider': 'openai-codex'}, {})
            self.assertEqual(len(calls), 2)
            get_usage({'provider': 'openai-codex'}, {}, refresh=True)
            self.assertEqual(len(calls), 4)
            changed = get_usage({'provider': 'anthropic'}, {})
            self.assertTrue(next(row for row in changed['providers'] if row['provider'] == 'anthropic')['isDefault'])

    def test_quota_is_remaining_and_unknown_is_not_zero(self):
        snapshot = SimpleNamespace(plan='Pro', windows=[
            SimpleNamespace(label='Session', used_percent=25, reset_at=datetime(2030, 1, 1, tzinfo=timezone.utc), detail=None),
            SimpleNamespace(label='Weekly', used_percent=None, reset_at=None, detail=None),
            SimpleNamespace(label='Invalid', used_percent=float('nan'), reset_at=None, detail=None),
        ], details=[], unavailable_reason=None, api_key='must-not-leak')
        result = project_usage('openai-codex', 'OpenAI', snapshot, 'openai-codex')
        self.assertEqual(result['windows'][0]['remainingPercent'], 75)
        self.assertEqual(result['windows'][0]['resetAt'], 1893456000000)
        self.assertIsNone(result['windows'][1]['remainingPercent'])
        self.assertIsNone(result['windows'][2]['remainingPercent'])
        self.assertNotIn('must-not-leak', str(result))

    def test_api_usage_is_explicitly_unavailable(self):
        result = project_usage('openai', 'OpenAI API', None, 'openai')
        self.assertFalse(result['available'])
        self.assertEqual(result['windows'], [])
        self.assertIn('API', result['unavailableReason'])

    def test_provider_error_is_not_exposed(self):
        result = project_usage('anthropic', 'Anthropic', SimpleNamespace(unavailable_reason='Bearer secret'), 'openai-codex')
        self.assertFalse(result['available'])
        self.assertNotIn('secret', str(result))


if __name__ == '__main__':
    unittest.main()
