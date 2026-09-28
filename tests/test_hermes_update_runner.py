from __future__ import annotations
import importlib.util
import json
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('update_runner', Path(__file__).resolve().parents[1] / 'scripts' / 'standalone' / 'update_runner.py')
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
TARGET = {'schemaVersion': 1, 'version': '2026.9.24', 'revision': 'f' * 40, 'image': 'nousresearch/hermes-agent:v2026.9.24@sha256:' + 'a' * 64, 'releaseUrl': 'https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.24'}

class RunnerTests(unittest.TestCase):
    def make_server(self, directory):
        (Path(directory) / 'update.sock').unlink(missing_ok=True)
        return runner.UpdateServer(str(Path(directory) / 'update.sock'), 'token' * 8, 'digitalchili/olympus', '/bin/true', hermes_command='/bin/true', hermes_mode='native', state_directory=str(Path(directory) / 'state'))

    def test_incomplete_operator_configuration_is_not_advertised_as_ready(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ValueError): runner.validate_hermes_configuration('native')
        with patch.dict(os.environ, {'OLYMPUS_HERMES_UPDATER_EXCLUSIVE': '1'}, clear=True):
            with self.assertRaises(ValueError): runner.validate_hermes_configuration('docker')

    def test_only_published_stable_release_can_authorize_manifest(self):
        valid = {'tag_name': 'v0.7.24', 'draft': False, 'prerelease': False, 'published_at': '2026-09-28T00:00:00Z'}
        for release in ({**valid, 'draft': True}, {**valid, 'prerelease': True}, {**valid, 'published_at': None}, {**valid, 'tag_name': 'v0.7.25'}):
            with patch.object(runner.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(release).encode())) as fetch:
                with self.assertRaises(ValueError): runner.load_release_target('0.7.24')
                self.assertEqual(fetch.call_count, 1)
        for version in ('01.2.3', '1.2.3-beta', '../main'):
            with patch.object(runner.urllib.request, 'urlopen') as fetch:
                with self.assertRaises(ValueError): runner.load_release_target(version)
                fetch.assert_not_called()
        with patch.object(runner.urllib.request, 'urlopen', side_effect=[io.BytesIO(json.dumps(valid).encode()), io.BytesIO(json.dumps(TARGET).encode())]):
            self.assertEqual(runner.load_release_target('0.7.24'), TARGET)

    def test_rejects_unapproved_target_before_command_start(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.make_server(directory) as server, patch.object(runner, 'load_release_target', return_value={**TARGET, 'revision': 'b' * 40}), patch.object(runner.subprocess, 'Popen') as spawn:
                with self.assertRaises(ValueError):
                    server.start_hermes_update({'repository': 'digitalchili/olympus', 'olympusVersion': '0.7.24', 'target': TARGET})
                spawn.assert_not_called()

    def test_shared_lock_and_private_durable_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.make_server(directory) as server, patch.object(runner, 'load_release_target', return_value=TARGET), patch.object(runner.subprocess, 'Popen') as spawn:
                spawn.return_value.poll.return_value = None
                self.assertTrue(server.start_hermes_update({'repository': 'digitalchili/olympus', 'olympusVersion': '0.7.24', 'target': TARGET}))
                self.assertFalse(server.start_update('0.7.24'))
                result = server.hermes_status()
                self.assertEqual(result['method'], 'native')
                self.assertEqual(result['operation']['phase'], 'preparing')
                args, kwargs = spawn.call_args
                self.assertEqual(args[0], ['/bin/true', '--olympus-version', '0.7.24'])
                request_file = Path(kwargs['env']['OLYMPUS_HERMES_UPDATE_REQUEST_FILE'])
                self.assertEqual(json.loads(request_file.read_text())['target'], TARGET)
                self.assertEqual(request_file.stat().st_mode & 0o777, 0o600)
                self.assertNotIn('target', kwargs['env'])
                spawn.return_value.poll.return_value = 1
                self.assertEqual(server.hermes_status()['operation']['phase'], 'failed')
            with self.make_server(directory) as restarted:
                self.assertEqual(restarted.hermes_status()['operation']['phase'], 'failed')

    def test_restart_marks_unfinished_operation_interrupted(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.make_server(directory) as server, patch.object(runner, 'load_release_target', return_value=TARGET), patch.object(runner.subprocess, 'Popen') as spawn:
                spawn.return_value.poll.return_value = None
                server.start_hermes_update({'repository': 'digitalchili/olympus', 'olympusVersion': '0.7.24', 'target': TARGET})
            with self.make_server(directory) as restarted:
                self.assertEqual(restarted.hermes_status()['operation']['phase'], 'interrupted')
                self.assertFalse(restarted.hermes_status()['configured'], 'uncertain child state must not allow another update')

if __name__ == '__main__':
    unittest.main()
