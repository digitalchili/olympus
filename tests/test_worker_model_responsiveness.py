"""Catalog I/O must not monopolize the JSONL reader or publish stale settings."""
from contextlib import ExitStack
import copy
import sys
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server' / 'workers'))
import hermes_worker as worker


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.config = {'model': {'provider': 'openai-codex', 'default': 'old-model'}}
        self.stack.enter_context(patch.object(worker, '_ensure_imports'))
        self.stack.enter_context(patch.object(worker, '_load_config', side_effect=lambda: copy.deepcopy(self.config)))
        self.stack.enter_context(patch.object(worker, '_curated_model_catalog', return_value=None))
        self.stack.enter_context(patch.object(worker, '_MODEL_LIST_CACHE', None))
        self.stack.enter_context(patch.object(worker, '_CONFIG_MTIME', 1))
        self.stack.enter_context(patch.dict(worker.ACTIVE_TASKS, {}, clear=True))
        self.results = {}
        self.condition = threading.Condition()
        self.stack.enter_context(patch.object(worker, '_result', side_effect=self.result))

    def result(self, rid, data):
        with self.condition:
            self.results[rid] = data
            self.condition.notify_all()

    def wait_result(self, rid):
        with self.condition:
            return self.condition.wait_for(lambda: rid in self.results, timeout=2)

    def test_reader_dispatches_health_inventory_chat_and_stop_during_catalog_io(self):
        entered, release, admitted = threading.Event(), threading.Event(), threading.Event()

        def discover(*_args):
            entered.set()
            self.assertTrue(release.wait(3))
            return {}

        def chat(_rid, _request, _key):
            admitted.set()

        def read_requests():
            for request in [
                {'id': 'catalog', 'type': 'models.list'},
                {'id': 'health', 'type': 'health'},
                {'id': 'inventory', 'type': 'session.backgroundWork.get', 'sessionId': 'task'},
                {'id': 'chat', 'type': 'chat', 'sessionId': 'task'},
                {'id': 'stop', 'type': 'chat.interrupt', 'sessionId': 'task'},
            ]:
                worker._handle_request(request)

        with (
            patch.object(worker, '_list_authenticated_model_groups', side_effect=discover),
            patch.object(worker, '_session_background_work', return_value={'available': True, 'work': []}),
            patch.object(worker, '_run_chat_thread', side_effect=chat),
        ):
            reader = threading.Thread(target=read_requests)
            reader.start()
            try:
                self.assertTrue(entered.wait(2))
                self.assertTrue(self.wait_result('stop'), 'catalog discovery blocked later reader requests')
                self.assertTrue(admitted.wait(2))
                self.assertIn('health', self.results)
                self.assertIn('inventory', self.results)
                self.assertNotIn('catalog', self.results)
                self.assertIn('task', worker.ACTIVE_TASKS)
                self.assertTrue(self.results['stop']['interrupted'])
            finally:
                release.set()
                reader.join(3)
                self.assertTrue(self.wait_result('catalog'))
                worker.PENDING_INTERRUPTS.pop('task', None)

    def test_simultaneous_misses_share_one_catalog_build(self):
        entered, release = threading.Event(), threading.Event()
        def discover(*_args):
            entered.set()
            self.assertTrue(release.wait(3))
            return {}
        with patch.object(worker, '_list_authenticated_model_groups', side_effect=discover) as build:
            threads = [threading.Thread(target=lambda key=key: self.result(key, worker._list_models())) for key in ('one', 'two')]
            for thread in threads: thread.start()
            try:
                self.assertTrue(entered.wait(2))
            finally:
                release.set()
                for thread in threads: thread.join(3)
            self.assertEqual(build.call_count, 1, 'parallel misses should use the same discovery result')
            self.assertEqual(self.results['one'], self.results['two'])

    def test_settings_change_during_discovery_does_not_wait_or_cache_old_result(self):
        entered, release = threading.Event(), threading.Event()
        def discover(*_args):
            entered.set()
            self.assertTrue(release.wait(3))
            return {}
        def save(cfg):
            self.config = copy.deepcopy(cfg)
        native_config = types.SimpleNamespace(load_config=lambda: copy.deepcopy(self.config), save_config=save)
        with (
            patch.object(worker, '_list_authenticated_model_groups', side_effect=discover) as build,
            patch.dict(sys.modules, {'hermes_cli.config': native_config}),
        ):
            catalog = threading.Thread(target=lambda: self.result('catalog', worker._list_models()))
            catalog.start()
            self.assertTrue(entered.wait(2))
            mutation = threading.Thread(target=worker._handle_request, args=({'id': 'settings', 'type': 'settings.set', 'model': 'new-model'},))
            mutation.start()
            try:
                self.assertTrue(self.wait_result('settings'), 'discovery must not hold the settings/admission lock')
            finally:
                release.set()
                mutation.join(3)
                catalog.join(3)
            self.assertEqual(self.results['catalog']['defaultModel'], 'new-model')
            self.assertEqual(worker._list_models()['defaultModel'], 'new-model')
            self.assertEqual(build.call_count, 2, 'same-mtime invalidation must discard and rebuild stale discovery')

    def test_catalog_error_uses_safe_response_and_original_request_id(self):
        done = threading.Event()
        errors = []
        with (
            patch.object(worker, '_list_authenticated_model_groups', side_effect=RuntimeError('SECRET upstream detail')),
            patch.object(worker, '_send_error', side_effect=lambda rid, err: (errors.append((rid, err)), done.set())),
        ):
            worker._handle_request({'id': 'catalog-error', 'type': 'models.list'})
            self.assertTrue(done.wait(2))
        self.assertEqual(errors[0][0], 'catalog-error')
        self.assertNotIn('SECRET', str(errors[0][1]))


if __name__ == '__main__':
    unittest.main()
