from __future__ import annotations
import importlib.util
import json
import os
import plistlib
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts' / 'standalone'))
PATH = Path(__file__).resolve().parents[1] / 'scripts' / 'standalone' / 'hermes_native_update.py'

class NativeUpdateTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(PATH.is_file(), 'a fixed native updater must exist')
        spec = importlib.util.spec_from_file_location('hermes_native_update', PATH)
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)

    def fixture(self, directory):
        root = Path(directory)
        source, home, state = root / 'source', root / 'home', root / 'state'
        for path in (source, home, state): path.mkdir()
        (source / 'run_agent.py').write_text('# source')
        (home / 'auth.json').write_text('PRIVATE_FIXTURE')
        (state / 'data').mkdir()
        (state / 'data' / 'project-secrets.key').write_text('PRIVATE_KEY_FIXTURE')
        operation = state / 'operation.json'
        operation.write_text(json.dumps({'id': 'fixture', 'phase': 'preparing', 'targetRevision': 'a' * 40, 'targetVersion': '2026.9.24', 'startedAt': 1, 'updatedAt': 1, 'message': 'Preparing'}))
        env = {'HERMES_AGENT_DIR': str(source), 'HERMES_HOME': str(home), 'HERMES_PYTHON': '/usr/bin/python3', 'OLYMPUS_DISPATCH_HOME': str(state), 'OLYMPUS_HERMES_UPDATE_STATUS_FILE': str(operation), 'OLYMPUS_HERMES_UPDATER_RESTART_COMMAND': '/usr/bin/true', 'OLYMPUS_HERMES_UPDATER_EXCLUSIVE': '1', 'OLYMPUS_MAINTENANCE_TOKEN': 'fixture-token', 'OLYMPUS_HERMES_UPDATER_BASE_URL': 'http://127.0.0.1:6969'}
        return env, root, operation

    def test_current_launchagent_selection_overrides_stale_runner_source(self):
        with tempfile.TemporaryDirectory() as directory:
            env, root, _ = self.fixture(directory)
            selected = root / 'selected'
            selected.mkdir()
            plist = root / 'selected.plist'
            plist.write_bytes(plistlib.dumps({'EnvironmentVariables': {'HERMES_AGENT_DIR': str(selected), 'HERMES_PYTHON': '/selected/venv/bin/python', 'HERMES_HOME': env['HERMES_HOME'], 'OLYMPUS_DISPATCH_HOME': env['OLYMPUS_DISPATCH_HOME']}}))
            with patch.dict(os.environ, {**env, 'OLYMPUS_HERMES_UPDATER_PLIST': str(plist)}, clear=True):
                updater = self.helper.NativeUpdater({'revision': 'a' * 40, 'version': '2026.9.24'})
            self.assertEqual(updater.source, selected.resolve())
            self.assertEqual(str(updater.python), '/selected/venv/bin/python')

    def test_broad_state_roots_are_rejected_before_any_update_work(self):
        with tempfile.TemporaryDirectory() as directory:
            env, _, _ = self.fixture(directory)
            for field, value in (('HERMES_HOME', '/'), ('OLYMPUS_DISPATCH_HOME', '/'), ('HERMES_HOME', str(Path.home())), ('HERMES_HOME', '/Users')):
                with patch.dict(os.environ, {**env, field: value}, clear=True):
                    with self.assertRaises(ValueError): self.helper.NativeUpdater({'revision': 'a' * 40, 'version': '2026.9.24'})

    def test_requested_olympus_release_must_match_running_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            env, _, _ = self.fixture(directory)
            with patch.dict(os.environ, env, clear=True):
                updater = self.helper.NativeUpdater({'revision': 'a' * 40, 'version': '2026.9.24'}, olympus_version='0.7.24')
                with patch.object(self.helper.urllib.request, 'urlopen') as request:
                    import io
                    request.return_value = io.BytesIO(b'{"version":"0.7.23"}')
                    with self.assertRaises(ValueError): updater.check_olympus_version()
                    request.return_value = io.BytesIO(b'{"version":"0.7.24"}')
                    updater.check_olympus_version()

    def test_backup_contains_secret_key_and_hermes_data_without_recursive_updater_files(self):
        import tarfile
        with tempfile.TemporaryDirectory() as directory:
            env, root, _ = self.fixture(directory)
            with patch.dict(os.environ, env, clear=True):
                updater = self.helper.NativeUpdater({'revision': 'a' * 40, 'version': '2026.9.24'})
                backup = updater.backup()
            with tarfile.open(backup) as archive:
                names = archive.getnames()
                self.assertIn('olympus/data/project-secrets.key', names)
                self.assertIn('hermes/auth.json', names)
                self.assertFalse(any('/updater/' in name or '/backups/' in name for name in names))
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)

    def test_state_restore_returns_original_data_and_preserves_recovery_files(self):
        with tempfile.TemporaryDirectory() as directory:
            env, root, _ = self.fixture(directory)
            state, home = root / 'state', root / 'home'
            os.link(home / 'auth.json', home / 'auth-copy.json')
            (state / 'updater').mkdir()
            (state / 'updater' / 'keep').write_text('recovery')
            with patch.dict(os.environ, env, clear=True):
                updater = self.helper.NativeUpdater({'revision': 'a' * 40, 'version': '2026.9.24'})
                archive = updater.backup()
                (home / 'auth.json').write_text('modified')
                (home / 'candidate-created').write_text('remove')
                (state / 'data' / 'project-secrets.key').write_text('modified key')
                updater.marker.write_text('fenced')
                updater.restore(archive)
            self.assertEqual((home / 'auth.json').read_text(), 'PRIVATE_FIXTURE')
            self.assertEqual((state / 'data' / 'project-secrets.key').read_text(), 'PRIVATE_KEY_FIXTURE')
            self.assertFalse((home / 'candidate-created').exists())
            self.assertEqual((state / 'updater' / 'keep').read_text(), 'recovery')
            self.assertEqual(updater.marker.read_text(), 'fenced')
            self.assertTrue(archive.exists())

    def test_changed_or_traversing_archive_never_clears_live_state(self):
        import io
        import tarfile
        for scenario in ('changed', 'traversal'):
            with tempfile.TemporaryDirectory() as directory:
                env, root, _ = self.fixture(directory)
                with patch.dict(os.environ, env, clear=True):
                    updater = self.helper.NativeUpdater({'revision': 'a' * 40, 'version': '2026.9.24'})
                    archive = updater.backup()
                    if scenario == 'changed':
                        with archive.open('ab') as stream: stream.write(b'changed')
                    else:
                        with tarfile.open(archive, 'w:gz') as stream:
                            member = tarfile.TarInfo('olympus/../outside')
                            member.size = 3
                            stream.addfile(member, io.BytesIO(b'bad'))
                        receipt = archive.parent / 'runtime.json'
                        value = json.loads(receipt.read_text())
                        value['sha256'] = updater.digest(archive)
                        receipt.write_text(json.dumps(value))
                    with self.assertRaises(RuntimeError): updater.restore(archive)
                self.assertEqual((root / 'home' / 'auth.json').read_text(), 'PRIVATE_FIXTURE')
                self.assertEqual((root / 'state' / 'data' / 'project-secrets.key').read_text(), 'PRIVATE_KEY_FIXTURE')

    def test_candidate_preflight_uses_disposable_home_and_failure_never_drains_live_install(self):
        with tempfile.TemporaryDirectory() as directory:
            env, root, operation = self.fixture(directory)
            capture = root / 'preflight.json'
            install_capture = root / 'install.json'
            stub = root / 'selected-python'
            script = "#!/usr/bin/env python3\nimport json, os, pathlib, sys\nargs=sys.argv[1:]\nif args[:2] == ['-m','venv']:\n p=pathlib.Path(args[2])/'bin'/'python'; p.parent.mkdir(parents=True); p.write_text(pathlib.Path(__file__).read_text()); p.chmod(0o700)\nelif args[:2] == ['-m','pip'] or args[0] == 'sync': pathlib.Path(" + repr(str(install_capture)) + ").write_text(json.dumps({**dict(os.environ), 'ARGV': args}))\nelif args[0] == '-c':\n pathlib.Path(" + repr(str(capture)) + ").write_text(json.dumps(dict(os.environ))); sys.exit(17)\nelse: sys.exit(18)\n"
            stub.write_text(script)
            stub.chmod(0o700)
            env.update(HERMES_PYTHON=str(stub), PATH=os.environ['PATH'], PRIVATE_FIXTURE_API_KEY='never-preflight')
            with patch.dict(os.environ, env, clear=True):
                updater = self.helper.NativeUpdater({'revision': 'a' * 40, 'version': '2026.9.24'})
                updater.validate = lambda: None
                updater.git_environment = dict(os.environ)
                updater.uv = str(stub)
                command = updater.command
                updater.command = lambda arguments, **kwargs: ('a' * 40 if arguments[0] == 'git' and 'rev-parse' in arguments else '') if arguments[0] == 'git' else command(arguments, **kwargs)
                updater.maintenance = lambda _: self.fail('candidate preflight must finish before contacting live maintenance')
                with self.assertRaises(RuntimeError): updater.run()
            installed = json.loads(install_capture.read_text())
            self.assertNotIn('PRIVATE_FIXTURE_API_KEY', installed)
            self.assertIn('--frozen', installed['ARGV'])
            self.assertEqual(installed['UV_PYTHON_DOWNLOADS'], 'never')
            seen = json.loads(capture.read_text())
            self.assertNotIn('PRIVATE_FIXTURE_API_KEY', seen)
            self.assertNotEqual(seen['HERMES_HOME'], env['HERMES_HOME'])
            self.assertEqual(seen['HOME'], seen['HERMES_HOME'])
            self.assertTrue(seen['HERMES_AGENT_DIR'].startswith(str((root / 'state').resolve())))
            self.assertEqual((root / 'home' / 'auth.json').read_text(), 'PRIVATE_FIXTURE')
            self.assertFalse((root / 'state' / '.hermes-update-in-progress').exists())
            self.assertEqual(json.loads(operation.read_text())['phase'], 'failed')

    def test_failed_candidate_restores_selected_runtime_before_resuming(self):
        with tempfile.TemporaryDirectory() as directory:
            env, root, operation = self.fixture(directory)
            candidate = root / 'candidate'
            candidate.mkdir()
            events = []
            with patch.dict(os.environ, env, clear=True):
                updater = self.helper.NativeUpdater({'revision': 'a' * 40, 'version': '2026.9.24'})
                updater.validate = lambda: None
                updater.prepare = lambda: candidate
                updater.drain = lambda: events.append('drain')
                updater.backup = lambda: events.append('backup')
                updater.stop = lambda source: events.append(('stop', source))
                updater.restore = lambda archive: events.append('restore')
                updater.restart = lambda source, python, expected: events.append(('restart', source))
                updater.verify = lambda revision: (_ for _ in ()).throw(RuntimeError('PRIVATE_DETAIL')) if revision == 'a' * 40 else events.append('verified original')
                updater.maintenance = lambda action: events.append(action)
                updater.original_revision = 'b' * 40
                with self.assertRaises(RuntimeError): updater.run()
            self.assertEqual(events, ['drain', ('stop', (root / 'source').resolve()), 'backup', ('restart', candidate), ('stop', candidate), 'restore', ('restart', (root / 'source').resolve()), 'verified original', 'cancel'])
            self.assertFalse((root / 'state' / '.hermes-update-in-progress').exists())
            status = json.loads(operation.read_text())
            self.assertEqual(status['phase'], 'rolled_back')
            self.assertNotIn('PRIVATE_DETAIL', json.dumps(status))

    def test_uncertain_resume_never_rolls_code_back_under_new_work(self):
        with tempfile.TemporaryDirectory() as directory:
            env, root, operation = self.fixture(directory)
            events = []
            with patch.dict(os.environ, env, clear=True):
                updater = self.helper.NativeUpdater({'revision': 'a' * 40, 'version': '2026.9.24'})
                updater.validate = lambda: None
                updater.prepare = lambda: root / 'candidate'
                updater.drain = lambda: None
                updater.backup = lambda: None
                updater.stop = lambda _: None
                updater.restart = lambda *_: events.append('restart')
                updater.verify = lambda _: None
                updater.maintenance = lambda action: (_ for _ in ()).throw(RuntimeError('uncertain reply')) if action == 'cancel' else events.append(action)
                with self.assertRaises(RuntimeError): updater.run()
            self.assertEqual(events, ['restart', 'drain'])
            self.assertTrue((root / 'state' / '.hermes-update-in-progress').exists())
            self.assertEqual(json.loads(operation.read_text())['phase'], 'interrupted')

    def test_rejected_preexisting_operation_never_removes_its_fence(self):
        with tempfile.TemporaryDirectory() as directory:
            env, root, operation = self.fixture(directory)
            marker = root / 'state' / '.hermes-update-in-progress'
            marker.write_text('existing operation')
            with patch.dict(os.environ, env, clear=True):
                updater = self.helper.NativeUpdater({'revision': 'a' * 40, 'version': '2026.9.24'})
                updater.validate = lambda: (_ for _ in ()).throw(ValueError('existing operation'))
                updater.maintenance = lambda _: self.fail('must not cancel another operation')
                with self.assertRaises(RuntimeError): updater.run()
            self.assertEqual(marker.read_text(), 'existing operation')

    def test_uncertain_resume_after_rollback_restores_fence(self):
        with tempfile.TemporaryDirectory() as directory:
            env, root, operation = self.fixture(directory)
            events = []
            with patch.dict(os.environ, env, clear=True):
                updater = self.helper.NativeUpdater({'revision': 'a' * 40, 'version': '2026.9.24'})
                updater.validate = lambda: None
                updater.prepare = lambda: root / 'candidate'
                updater.drain = lambda: None
                updater.stop = lambda _: None
                updater.backup = lambda: None
                updater.restore = lambda _: None
                updater.restart = lambda *_: events.append('restart')
                updater.verify = lambda revision: (_ for _ in ()).throw(RuntimeError('candidate failed')) if revision == 'a' * 40 else None
                updater.maintenance = lambda action: (_ for _ in ()).throw(RuntimeError('uncertain reply')) if action == 'cancel' else events.append(action)
                with self.assertRaises(RuntimeError): updater.run()
            self.assertEqual(events, ['restart', 'restart', 'drain'])
            self.assertTrue((root / 'state' / '.hermes-update-in-progress').exists())
            self.assertEqual(json.loads(operation.read_text())['phase'], 'interrupted')

    def test_failed_rollback_keeps_admission_fence(self):
        with tempfile.TemporaryDirectory() as directory:
            env, root, operation = self.fixture(directory)
            with patch.dict(os.environ, env, clear=True):
                updater = self.helper.NativeUpdater({'revision': 'a' * 40, 'version': '2026.9.24'})
                updater.validate = lambda: None
                updater.prepare = lambda: root / 'candidate'
                updater.drain = lambda: None
                updater.backup = lambda: None
                updater.stop = lambda _: None
                updater.restore = lambda _: None
                updater.restart = lambda *_: (_ for _ in ()).throw(RuntimeError('restart failed'))
                updater.maintenance = lambda _: self.fail('must not resume uncertain runtime')
                with self.assertRaises(RuntimeError): updater.run()
            self.assertTrue((root / 'state' / '.hermes-update-in-progress').exists())
            self.assertEqual(json.loads(operation.read_text())['phase'], 'interrupted')

if __name__ == '__main__': unittest.main()
