import importlib.util
import os
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[1] / 'scripts' / 'standalone' / 'hermes_macos_restart.py'

class RestartTests(unittest.TestCase):
    def test_only_selected_runtime_paths_change_and_unrelated_settings_survive(self):
        self.assertTrue(PATH.is_file(), 'the selected Mac service needs a concrete restart helper')
        spec = importlib.util.spec_from_file_location('hermes_macos_restart', PATH)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            old, new, home = root / 'old', root / 'new', root / 'home'
            for path in (old, new, home): path.mkdir()
            (new / 'run_agent.py').write_text('')
            python = new / 'python'
            python.write_text('#!/bin/sh\nexit 0')
            python.chmod(0o700)
            plist = root / 'service.plist'
            original = {'Label': 'fixture.olympus', 'ProgramArguments': ['/fixture/node', '/fixture/app.js'], 'EnvironmentVariables': {'HERMES_AGENT_DIR': str(old), 'HERMES_PYTHON': '/old/python', 'HERMES_HOME': str(home), 'OLYMPUS_DISPATCH_HOME': '/state', 'OLYMPUS_MAINTENANCE_TOKEN': 'PRIVATE_FIXTURE'}}
            plist.write_bytes(plistlib.dumps(original))
            environment = {'OLYMPUS_HERMES_UPDATER_PLIST': str(plist), 'OLYMPUS_HERMES_EXPECTED_SOURCE': str(old), 'OLYMPUS_HERMES_CANDIDATE_SOURCE': str(new), 'OLYMPUS_HERMES_CANDIDATE_PYTHON': str(python), 'HERMES_HOME': str(home), 'OLYMPUS_DISPATCH_HOME': '/state'}
            with patch.dict(os.environ, environment, clear=True), patch.object(helper.subprocess, 'run') as run:
                run.return_value.returncode = 0
                helper.restart()
            saved = plistlib.loads(plist.read_bytes())
            expected = {**original, 'EnvironmentVariables': {**original['EnvironmentVariables'], 'HERMES_AGENT_DIR': str(new), 'HERMES_PYTHON': str(python)}}
            self.assertEqual(saved, expected)
            self.assertEqual(run.call_args_list[0].args[0][0:2], ['/bin/launchctl', 'bootout'])
            with patch.dict(os.environ, environment, clear=True), patch.object(helper.subprocess, 'run') as run:
                with self.assertRaises(ValueError): helper.restart()
                run.assert_not_called()
            self.assertEqual(plistlib.loads(plist.read_bytes()), expected)

    def test_stop_requires_confirmed_process_exit_and_never_changes_selection(self):
        self.assertTrue(PATH.is_file())
        spec = importlib.util.spec_from_file_location('hermes_macos_restart', PATH)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source, home = root / 'source', root / 'home'
            source.mkdir(); home.mkdir()
            plist = root / 'service.plist'
            original = {'Label': 'fixture.olympus', 'EnvironmentVariables': {'HERMES_AGENT_DIR': str(source), 'HERMES_HOME': str(home), 'OLYMPUS_DISPATCH_HOME': '/state'}}
            plist.write_bytes(plistlib.dumps(original))
            environment = {'OLYMPUS_HERMES_UPDATER_PLIST': str(plist), 'OLYMPUS_HERMES_EXPECTED_SOURCE': str(source), 'HERMES_HOME': str(home), 'OLYMPUS_DISPATCH_HOME': '/state', 'OLYMPUS_HERMES_SERVICE_ACTION': 'stop'}
            with patch.dict(os.environ, environment, clear=True), patch.object(helper.subprocess, 'run') as run, patch.object(helper.os, 'kill', side_effect=ProcessLookupError):
                run.return_value.returncode = 0
                run.return_value.stdout = 'pid = 4242\n'
                helper.restart()
            self.assertEqual(plistlib.loads(plist.read_bytes()), original)
            self.assertEqual([item.args[0][1] for item in run.call_args_list], ['print', 'bootout'])
            with patch.dict(os.environ, environment, clear=True), patch.object(helper.subprocess, 'run') as run, patch.object(helper.os, 'kill'), patch.object(helper.time, 'sleep'):
                run.return_value.returncode = 0
                run.return_value.stdout = 'pid = 4242\n'
                with self.assertRaises(RuntimeError): helper.restart()

if __name__ == '__main__': unittest.main()
