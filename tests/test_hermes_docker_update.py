from __future__ import annotations
import importlib.util
import copy
import contextlib
import json
import io
import os
from pathlib import Path
import sys
import tempfile
import tarfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts' / 'standalone'))
SPEC = importlib.util.spec_from_file_location('hermes_docker_update', ROOT / 'scripts' / 'standalone' / 'hermes_docker_update.py')
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)
REAL_API = helper.DockerUpdate.api

TARGET = {'schemaVersion': 1, 'version': '2026.9.24', 'revision': 'f' * 40, 'image': 'nousresearch/hermes-agent:v2026.9.24@sha256:' + 'a' * 64, 'releaseUrl': 'https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.24'}
OLD_IMAGE, NEW_IMAGE = 'sha256:' + '1' * 64, 'sha256:' + '2' * 64
PIN = 'ghcr.io/digitalchili/olympus@sha256:' + '3' * 64
OLD_PIN = 'ghcr.io/digitalchili/olympus@sha256:' + '4' * 64


class Installation:
    """Real temporary state/configuration; only Docker, HTTP and release boundaries are replaced."""
    def __init__(self, root: Path, mode='docker'):
        self.root, self.mode = root, mode
        self.compose_dir = root / 'compose'; self.compose_dir.mkdir()
        self.home = root / 'data'; self.home.mkdir()
        self.olympus = self.home / 'olympus'; self.olympus.mkdir()
        self.data = self.home / 'sessions.txt'; self.data.write_text('original sessions')
        self.env = self.compose_dir / '.env'
        self.original_env = 'SYNTHETIC_KEY=fixture-only\nOLYMPUS_DISPATCH_IMAGE=ghcr.io/digitalchili/olympus:0.7.24\n'
        self.env.write_text(self.original_env); self.env.chmod(0o600)
        self.compose_file = self.compose_dir / 'docker-compose.yml'
        self.compose_file.write_text('services:\n  olympus-dispatch:\n    image: ${OLYMPUS_DISPATCH_IMAGE}\n')
        self.status = root / 'operation.json'
        helper.atomic_json(self.status, {'id': 'fixture', 'phase': 'preparing', 'targetRevision': TARGET['revision'], 'targetVersion': TARGET['version'], 'startedAt': 1, 'updatedAt': 1, 'message': 'Starting.'})
        self.request = root / 'request.json'
        helper.atomic_json(self.request, {'repository': 'digitalchili/olympus', 'olympusVersion': '0.7.25', 'target': TARGET})
        self.remote = {'composeId': 'selected-id', 'appName': 'selected', 'sourceType': 'raw', 'composeType': 'docker-compose', 'autoDeploy': False, 'isolatedDeployment': False, 'composeFile': self.compose_file.read_text(), 'env': self.original_env}
        self.key = root / 'key'; self.key.write_text('synthetic-private-key'); self.key.chmod(0o600)
        self.identifier, self.image, self.running = 'old-container', OLD_IMAGE, True
        self.events, self.failures, self.docker_calls = [], {}, []
        self.draining = False
        self.environment = {'OLYMPUS_HERMES_UPDATER_EXCLUSIVE': '1', 'OLYMPUS_HERMES_UPDATE_REQUEST_FILE': str(self.request), 'OLYMPUS_HERMES_UPDATE_STATUS_FILE': str(self.status), 'OLYMPUS_UPDATER_COMPOSE_DIR': str(self.compose_dir), 'OLYMPUS_UPDATER_COMPOSE_PROJECT': 'selected', 'OLYMPUS_HERMES_UPDATER_MODE': mode, 'OLYMPUS_DOKPLOY_URL': 'https://synthetic.invalid', 'OLYMPUS_DOKPLOY_API_KEY_FILE': str(self.key), 'OLYMPUS_DOKPLOY_COMPOSE_ID': 'selected-id', 'OLYMPUS_HERMES_UPDATER_STATE_DIR': str(root)}

    def event(self, name):
        self.events.append(name)
        failure = self.failures.pop(name, None)
        if callable(failure): failure()
        elif failure: raise helper.UpdateError('Synthetic boundary failure.')

    def info(self):
        return {'Id': self.identifier, 'Image': self.image, 'State': {'Running': self.running}, 'Config': {'Image': 'ghcr.io/digitalchili/olympus:0.7.24' if self.image == OLD_IMAGE else PIN, 'Labels': {'com.docker.compose.project': 'selected', 'com.docker.compose.service': 'olympus-dispatch'}, 'Env': ['HERMES_HOME=' + str(self.home), 'OLYMPUS_DISPATCH_HOME=' + str(self.olympus)]}, 'Mounts': [{'Destination': str(self.home), 'RW': True, 'Type': 'bind', 'Source': str(self.home)}]}

    def docker(self, *args, **kwargs):
        self.docker_calls.append(args)
        if args[:2] == ('ps', '-aq'): return self.identifier if '--no-trunc' in args else self.identifier[:12]
        if args[:2] == ('ps', '-q'): return self.identifier if self.running else ''
        if args[0] == 'inspect': return json.dumps([self.info()])
        if args[0] == 'pull': self.event('pull'); return ''
        if args[:2] == ('image', 'inspect'):
            if args[2] == OLD_IMAGE: return json.dumps([{'Id': OLD_IMAGE, 'RepoDigests': [OLD_PIN]}])
            return json.dumps([{'Id': NEW_IMAGE, 'RepoDigests': [PIN], 'Config': {'Labels': {'org.opencontainers.image.version': '0.7.25', 'org.opencontainers.image.source': 'https://github.com/digitalchili/olympus'}}}])
        if args[0] == 'run' and helper.PREFLIGHT_SCRIPT in args: self.event('preflight'); return json.dumps(TARGET)
        if args[0] == 'run' and helper.ARCHIVE_SCRIPT in args:
            if not hasattr(tarfile, 'data_filter'):
                raise unittest.SkipTest('Real container archive integration requires Python 3.12+')
            action = args[-1]; self.event(action)
            if self.running: raise AssertionError('State backup/restore cannot run beneath a writer')
            mount = args[args.index('--mount') + 1]
            backup = Path(mount.split('src=', 1)[1].split(',dst=', 1)[0])
            script = helper.ARCHIVE_SCRIPT.replace("Path('/backup/state.tar')", repr(backup / 'state.tar'))
            # Execute the production archive code on disposable roots, never host data.
            before = os.umask(0o077)
            try:
                with patch.object(sys, 'argv', ['archive', json.dumps([str(self.home)]), str(self.olympus), action]):
                    try: exec(compile(script, '<archive fixture>', 'exec'), {'PosixPath': Path})
                    except Exception as error: raise helper.UpdateError('Container archive step failed.') from error
            finally: os.umask(before)
            return ''
        if args[0] == 'exec' and helper.FENCE_SCRIPT in args:
            action = args[-2]; self.event('fence-' + action)
            fence = self.olympus / '.hermes-update-in-progress'
            if action == 'create': fence.write_text('fixture')
            else: fence.unlink()
            return ''
        if args[0] == 'stop': self.event('stop-' + ('old' if self.image == OLD_IMAGE else 'candidate')); self.running = False; return ''
        if args[0] == 'start': self.event('start-old'); self.running = True; return ''
        raise AssertionError(('Unexpected Docker command', args))

    def command(self, arguments, **kwargs):
        if arguments[0] == 'docker' and arguments[1] != 'compose': return self.docker(*arguments[1:], **kwargs)
        if 'config' in arguments:
            image = next(line.split('=', 1)[1] for line in self.env.read_text().splitlines() if line.startswith('OLYMPUS_DISPATCH_IMAGE='))
            return json.dumps({'services': {'olympus-dispatch': {'image': image, 'environment': {'HERMES_HOME': str(self.home), 'OLYMPUS_DISPATCH_HOME': str(self.olympus)}, 'volumes': [{'type': 'bind', 'source': str(self.home), 'target': str(self.home)}]}}})
        if 'up' in arguments:
            image = next(line.split('=', 1)[1] for line in self.env.read_text().splitlines() if line.startswith('OLYMPUS_DISPATCH_IMAGE='))
            self.event('up-' + ('old' if image in {OLD_IMAGE, OLD_PIN} else 'candidate'))
            if self.running: raise AssertionError('Replacement may not start while previous writer runs')
            self.image = OLD_IMAGE if image in {OLD_IMAGE, OLD_PIN} else NEW_IMAGE
            self.identifier = 'restored-container' if self.image == OLD_IMAGE else 'candidate-container'
            self.running = True
            if self.image == NEW_IMAGE: self.data.write_text('candidate modified state')
            return ''
        raise AssertionError(('Unexpected host command', arguments))

    def api(self, path, method='GET'):
        if path.endswith('/drain'):
            changed = not self.draining; self.draining = True; self.event('drain'); return {'changed': changed, 'draining': True}
        if path.endswith('/status'): return {'draining': self.draining, 'activeRuns': 0}
        if path.endswith('/check'):
            self.event('check-' + ('old' if self.image == OLD_IMAGE else 'candidate'))
            return {'ready': True, 'runtime': {'revision': 'a' * 40 if self.image == OLD_IMAGE else TARGET['revision']}}
        if path.endswith('/cancel'): self.draining = False; self.event('cancel'); return {'changed': True}
        if path.endswith('/ready'): self.event('ready'); return {'ready': not self.draining}
        raise AssertionError(path)

    def dokploy_api(self, route, body=None):
        if route.startswith('compose.one'): return copy.deepcopy(self.remote)
        if route == 'compose.update': self.remote['env'] = body['env']; self.event('remote-write'); return {}
        raise AssertionError(route)

    @contextlib.contextmanager
    def boundaries(self):
        fixture = self
        with patch.dict(os.environ, self.environment), patch.object(helper, 'load_release_target', return_value=TARGET), patch.object(helper, 'run', side_effect=self.command), patch.object(helper.DockerUpdate, 'docker', lambda _self, *args, **kwargs: fixture.docker(*args, **kwargs)), patch.object(helper.DockerUpdate, 'api', lambda _self, *args, **kwargs: fixture.api(*args, **kwargs)), patch.object(helper.DockerUpdate, 'dokploy_api', lambda _self, *args, **kwargs: fixture.dokploy_api(*args, **kwargs)):
            yield

    @contextlib.contextmanager
    def updater(self):
        with self.boundaries():
            yield helper.DockerUpdate('0.7.25')

class DockerUpdateTests(unittest.TestCase):
    def test_maintenance_never_targets_an_external_replacement_container(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Installation(Path(directory))
            with f.updater() as update:
                f.identifier = 'external-replacement'
                with self.assertRaises(helper.UpdateError): REAL_API(update, '/api/maintenance/drain', 'POST')
                self.assertFalse(any(call[0] == 'exec' for call in f.docker_calls))

    def test_selected_identity_uses_full_docker_container_id(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Installation(Path(directory)); f.identifier = 'a' * 64
            with f.updater() as update:
                update.execute()
                self.assertEqual(json.loads(f.status.read_text())['phase'], 'completed')
    def test_success_keeps_private_backup_and_releases_only_verified_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Installation(Path(directory))
            with f.updater() as update:
                update.execute()
                self.assertEqual(json.loads(f.status.read_text())['phase'], 'completed')
                self.assertEqual(f.image, NEW_IMAGE)
                self.assertFalse(f.draining)
                self.assertEqual((update.backup / 'compose.env').read_text(), f.original_env)
                self.assertEqual((update.backup / 'compose.env').stat().st_mode & 0o077, 0)
                self.assertEqual((update.backup / 'state.tar').stat().st_mode & 0o077, 0)
                self.assertLess(f.events.index('stop-old'), f.events.index('backup'))
                self.assertLess(f.events.index('check-candidate'), f.events.index('cancel'))

    def test_early_failure_never_cancels_another_maintenance_drain(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Installation(Path(directory)); f.draining = True; f.failures['pull'] = True
            with f.updater() as update:
                with self.assertRaises(helper.UpdateError): update.execute()
                update.recover()
                self.assertTrue(f.draining)
                self.assertNotIn('cancel', f.events)

    def test_existing_drain_is_not_claimed_by_the_update(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Installation(Path(directory)); f.draining = True
            with f.updater() as update:
                with self.assertRaises(helper.UpdateError): update.execute()
                update.recover()
                self.assertTrue(f.draining)
                self.assertNotIn('stop-old', f.events)

    def test_lost_release_reply_refences_without_restoring_resumed_state(self):
        for boundary in ['cancel', 'ready']:
            with self.subTest(boundary=boundary), tempfile.TemporaryDirectory() as directory:
                f = Installation(Path(directory)); f.failures[boundary] = True
                with f.updater() as update:
                    with self.assertRaises(helper.UpdateError): update.execute()
                    f.data.write_text('new work after release')
                    with self.assertRaises(helper.UpdateError): update.recover()
                    self.assertTrue(f.draining)
                    self.assertTrue((f.olympus / '.hermes-update-in-progress').exists())
                    self.assertEqual(f.data.read_text(), 'new work after release')
                    self.assertNotIn('restore', f.events)

    @unittest.skipUnless(hasattr(tarfile, 'data_filter'), 'Archive integration requires the container Python tar data filter; use Python 3.12+')
    def test_lost_rollback_release_reply_refences_and_retains_new_work(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Installation(Path(directory))
            def lost_reply():
                f.data.write_text('work accepted after rollback')
                raise helper.UpdateError('lost cancellation reply')
            f.failures['cancel'] = lost_reply
            with f.updater() as update:
                original_verify = update.verify
                def verify(revision):
                    if revision == TARGET['revision']: raise helper.UpdateError('candidate failed')
                    original_verify(revision)
                with patch.object(update, 'verify', side_effect=verify):
                    with self.assertRaises(helper.UpdateError): update.execute()
                    with self.assertRaises(helper.UpdateError): update.recover()
                self.assertTrue(f.draining)
                self.assertTrue((f.olympus / '.hermes-update-in-progress').exists())
                self.assertEqual(f.data.read_text(), 'work accepted after rollback')
                self.assertEqual(f.events.count('restore'), 1)

    @unittest.skipUnless(hasattr(tarfile, 'data_filter'), 'Archive integration requires the container Python tar data filter; use Python 3.12+')
    def test_failed_candidate_restores_data_and_exact_old_image_not_mutable_tag(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Installation(Path(directory))
            with f.updater() as update:
                original_verify = update.verify
                def verify(revision):
                    if revision == TARGET['revision']: raise helper.UpdateError('candidate failed')
                    original_verify(revision)
                with patch.object(update, 'verify', side_effect=verify):
                    with self.assertRaises(helper.UpdateError): update.execute()
                    update.recover()
                self.assertEqual(json.loads(f.status.read_text())['phase'], 'rolled_back')
                self.assertEqual(f.image, OLD_IMAGE)
                self.assertEqual(f.data.read_text(), 'original sessions')
                self.assertIn('OLYMPUS_DISPATCH_IMAGE=' + OLD_IMAGE, f.env.read_text())
                self.assertEqual((update.backup / 'compose.env').read_text(), f.original_env)
                self.assertLess(f.events.index('stop-candidate'), f.events.index('restore'))

    @unittest.skipUnless(hasattr(tarfile, 'data_filter'), 'Archive integration requires the container Python tar data filter; use Python 3.12+')
    def test_dokploy_rollback_saves_pullable_old_digest_and_keeps_original_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Installation(Path(directory), 'dokploy')
            with f.updater() as update:
                original_verify = update.verify
                def verify(revision):
                    if revision == TARGET['revision']: raise helper.UpdateError('candidate failed')
                    original_verify(revision)
                with patch.object(update, 'verify', side_effect=verify):
                    with self.assertRaises(helper.UpdateError): update.execute()
                    update.recover()
                self.assertEqual(f.remote['env'], 'SYNTHETIC_KEY=fixture-only\nOLYMPUS_DISPATCH_IMAGE=' + OLD_PIN + '\n')
                self.assertEqual(f.image, OLD_IMAGE)
                self.assertEqual(f.data.read_text(), 'original sessions')
                self.assertEqual((update.backup / 'compose.env').read_text(), f.original_env)

    @unittest.skipUnless(hasattr(tarfile, 'data_filter'), 'Archive integration requires the container Python tar data filter')
    def test_rollback_preserves_numeric_ownership_of_private_runtime_files(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Installation(Path(directory)); f.data.chmod(0o600)
            original_owner = (f.data.stat().st_uid, f.data.stat().st_gid)
            restored_owners = []
            chown = tarfile.TarFile.chown
            def record_owner(archive, member, path, numeric_owner):
                if member.name.endswith('/sessions.txt'): restored_owners.append((member.uid, member.gid, numeric_owner))
                return chown(archive, member, path, numeric_owner)
            with f.updater() as update, patch.object(tarfile.TarFile, 'chown', record_owner):
                original_verify = update.verify
                def verify(revision):
                    if revision == TARGET['revision']: raise helper.UpdateError('candidate failed')
                    original_verify(revision)
                with patch.object(update, 'verify', side_effect=verify):
                    with self.assertRaises(helper.UpdateError): update.execute()
                    update.recover()
                self.assertEqual(restored_owners, [(*original_owner, True)])
                self.assertEqual(f.data.stat().st_mode & 0o777, 0o600)

    def test_failed_candidate_stop_never_restores_any_state(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Installation(Path(directory)); f.failures['stop-candidate'] = True
            with f.updater() as update, patch.object(update, 'verify', side_effect=helper.UpdateError('candidate failed')):
                with self.assertRaises(helper.UpdateError): update.execute()
                with self.assertRaises(helper.UpdateError): update.recover()
                self.assertNotIn('restore', f.events)
                self.assertEqual(f.data.read_text(), 'candidate modified state')
                self.assertTrue((f.olympus / '.hermes-update-in-progress').exists())

    @unittest.skipUnless(hasattr(tarfile, 'data_filter'), 'Archive integration requires the container Python tar data filter; use Python 3.12+')
    def test_corrupt_backup_is_rejected_before_current_state_is_cleared(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Installation(Path(directory))
            with f.updater() as update, patch.object(update, 'verify', side_effect=helper.UpdateError('candidate failed')):
                with self.assertRaises(helper.UpdateError): update.execute()
                (update.backup / 'state.tar').write_bytes(b'corrupt archive')
                with self.assertRaises(helper.UpdateError): update.recover()
                self.assertEqual(f.data.read_text(), 'candidate modified state')
                self.assertFalse(f.running)
                self.assertTrue((f.olympus / '.hermes-update-in-progress').exists())

    @unittest.skipUnless(hasattr(tarfile, 'data_filter'), 'Archive integration requires the container Python tar data filter')
    def test_unsupported_archive_link_fails_before_candidate_and_preserves_original_state(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Installation(Path(directory)); (f.home / 'outside-link').symlink_to('/outside-selected-state')
            with f.updater() as update:
                with self.assertRaises(helper.UpdateError): update.execute()
                update.recover()
                self.assertNotIn('up-candidate', f.events)
                self.assertEqual(f.data.read_text(), 'original sessions')
                self.assertEqual(f.image, OLD_IMAGE)
                self.assertEqual(json.loads(f.status.read_text())['phase'], 'failed')

    def test_changed_service_before_rollback_is_not_stopped_or_restored(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Installation(Path(directory))
            with f.updater() as update, patch.object(update, 'verify', side_effect=helper.UpdateError('candidate failed')):
                with self.assertRaises(helper.UpdateError): update.execute()
                f.identifier = 'external-replacement'
                with self.assertRaises(helper.UpdateError): update.recover()
                self.assertNotIn('stop-candidate', f.events)
                self.assertNotIn('restore', f.events)

    def test_dokploy_compose_change_is_preserved_before_any_remote_write(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Installation(Path(directory), 'dokploy')
            with f.updater() as update:
                f.remote['composeFile'] += '  another-service: {}\n'
                with self.assertRaises(helper.UpdateError): update.execute()
                update.recover()
                self.assertNotIn('remote-write', f.events)
                self.assertNotIn('drain', f.events)

    def test_dry_run_requires_no_receipts_and_creates_or_mutates_nothing(self):
        for mode in ['docker', 'dokploy']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                f = Installation(Path(directory), mode)
                f.request.unlink(); f.status.unlink()
                f.environment.pop('OLYMPUS_HERMES_UPDATE_REQUEST_FILE')
                f.environment.pop('OLYMPUS_HERMES_UPDATE_STATUS_FILE')
                before = {str(path.relative_to(f.root)): path.read_bytes() for path in f.root.rglob('*') if path.is_file()}
                output = io.StringIO()
                with f.boundaries(), patch.object(sys, 'argv', ['hermes_docker_update.py', '--dry-run', '--olympus-version', '0.7.25']), contextlib.redirect_stdout(output):
                    self.assertEqual(helper.main(), 0)
                after = {str(path.relative_to(f.root)): path.read_bytes() for path in f.root.rglob('*') if path.is_file()}
                self.assertEqual(after, before)
                self.assertFalse(any(path.name.startswith('backup-') for path in f.root.iterdir()))
                self.assertEqual(f.events, [])
                self.assertTrue(all(command[0] in {'ps', 'inspect'} or command[:2] == ('image', 'inspect') for command in f.docker_calls))
                result = json.loads(output.getvalue())
                self.assertEqual(result['project'], 'selected')
                self.assertEqual(result['service'], 'olympus-dispatch')
                self.assertEqual(result['hermesHome'], str(f.home))
                self.assertEqual(result['olympusVersion'], '0.7.25')
                self.assertEqual(result['hermesRevision'], TARGET['revision'])
                self.assertNotIn('fixture-only', output.getvalue())
                self.assertNotIn('synthetic-private-key', output.getvalue())

    def test_changed_service_or_compose_file_stops_before_drain_or_state_mutation(self):
        for change in ['container', 'compose', 'env']:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                f = Installation(Path(directory))
                with f.updater() as update:
                    if change == 'container': f.identifier = 'foreign-replacement'
                    elif change == 'compose': f.compose_file.write_text('services: changed\n')
                    else: f.env.write_text(f.original_env + 'CONCURRENT=keep\n')
                    with self.assertRaises(helper.UpdateError): update.execute()
                    with contextlib.suppress(helper.UpdateError): update.recover()
                    self.assertNotIn('drain', f.events)
                    self.assertNotIn('stop-old', f.events)
                    self.assertEqual(f.data.read_text(), 'original sessions')

    def test_partial_dokploy_write_never_attempts_automatic_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Installation(Path(directory), 'dokploy'); f.failures['remote-write'] = True
            with f.updater() as update:
                with self.assertRaises(helper.UpdateError): update.execute()
                with self.assertRaises(helper.UpdateError): update.recover()
                self.assertFalse(f.running)
                self.assertTrue(f.draining)
                self.assertNotIn('restore', f.events)
                self.assertEqual(f.env.read_text(), f.original_env)
                self.assertIn(PIN, f.remote['env'])

    def test_local_change_during_temporary_env_write_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Installation(Path(directory))
            sync = helper.os.fsync
            changed = False
            def concurrent_edit(descriptor):
                nonlocal changed
                sync(descriptor)
                if (f.compose_dir / '.env.hermes-update').exists() and not changed:
                    f.env.write_text(f.original_env + 'CONCURRENT=preserve\n'); changed = True
            with f.updater() as update, patch.object(helper.os, 'fsync', side_effect=concurrent_edit):
                with self.assertRaises(helper.UpdateError): update.execute()
                with self.assertRaises(helper.UpdateError): update.recover()
                self.assertIn('CONCURRENT=preserve', f.env.read_text())
                self.assertNotIn('restore', f.events)
                self.assertFalse(f.running)

    def test_nonprivate_environment_is_rejected_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            f = Installation(Path(directory)); f.env.chmod(0o644)
            with self.assertRaises(helper.UpdateError):
                with f.updater(): pass
            self.assertFalse((f.root / 'backup-fixture').exists())

    def test_image_variable_preserves_other_settings_and_rejects_duplicates(self):
        original = 'TOKEN=never-print-this\nOLYMPUS_DISPATCH_IMAGE=old\nOTHER=value\n'
        changed = helper.replace_image(original, 'ghcr.io/digitalchili/olympus@sha256:' + 'a' * 64)
        self.assertIn('TOKEN=never-print-this\n', changed)
        self.assertIn('OTHER=value\n', changed)
        self.assertNotIn('=old', changed)
        with self.assertRaises(helper.UpdateError): helper.replace_image(original + 'OLYMPUS_DISPATCH_IMAGE=duplicate\n', 'new')
        with self.assertRaises(helper.UpdateError): helper.replace_image('OTHER=value\n', 'new')

    def test_mounts_and_service_identity_are_required(self):
        info = {'Config': {'Labels': {'com.docker.compose.project': 'selected', 'com.docker.compose.service': 'olympus-dispatch'}, 'Env': ['HERMES_HOME=/opt/data', 'OLYMPUS_DISPATCH_HOME=/opt/data/olympus-dispatch']}, 'Mounts': [{'Destination': '/opt/data', 'RW': True, 'Type': 'volume', 'Name': 'selected-data'}]}
        self.assertEqual(helper.selected_state(info, 'selected', 'olympus-dispatch'), ('/opt/data', '/opt/data/olympus-dispatch'))
        with self.assertRaises(helper.UpdateError): helper.selected_state(info, 'foreign', 'olympus-dispatch')
        info['Mounts'] = []
        with self.assertRaises(helper.UpdateError): helper.selected_state(info, 'selected', 'olympus-dispatch')

    def test_dokploy_validation_rejects_ambiguous_and_automatic_ownership(self):
        base = {'appName': 'selected', 'sourceType': 'raw', 'composeType': 'docker-compose', 'autoDeploy': False, 'isolatedDeployment': False, 'composeFile': 'services:\n  olympus-dispatch:\n    image: ${OLYMPUS_DISPATCH_IMAGE}\n', 'env': 'OLYMPUS_DISPATCH_IMAGE=old\n'}
        helper.validate_dokploy(base, 'selected')
        for change in [{'appName': 'foreign'}, {'autoDeploy': True}, {'isolatedDeployment': True}, {'sourceType': 'github'}, {'composeFile': 'image: hardcoded'}]:
            with self.assertRaises(helper.UpdateError): helper.validate_dokploy({**base, **change}, 'selected')

    def test_failure_after_candidate_start_stops_it_before_restoring_data(self):
        events = []
        helper.recover_candidate(stop=lambda: events.append('stop'), restore=lambda: events.append('restore'), start=lambda: events.append('start'), verify=lambda: events.append('verify'), release=lambda: events.append('release'))
        self.assertEqual(events, ['stop', 'restore', 'start', 'verify', 'release'])
        events.clear()
        def bad_stop(): events.append('stop'); raise helper.UpdateError('failed')
        with self.assertRaises(helper.UpdateError): helper.recover_candidate(stop=bad_stop, restore=lambda: events.append('restore'), start=lambda: events.append('start'), verify=lambda: events.append('verify'), release=lambda: events.append('release'))
        self.assertEqual(events, ['stop'], 'never restore beneath an unconfirmed writer')

if __name__ == '__main__': unittest.main()
