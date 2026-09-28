#!/usr/bin/env python3
"""Install an approved Hermes candidate for one explicitly selected Olympus service.

The existing source and profile data remain in place. A fixed operator-owned
restart helper changes only this Olympus service's source/interpreter selection.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request

from update_runner import atomic_json, load_release_target, validate_command, validate_target, VERSION_RE


def required_path(name: str) -> Path:
    value = os.environ.get(name, '')
    path = Path(value)
    if not value or not path.is_absolute():
        raise ValueError('The selected native installation needs explicit absolute paths.')
    return path.resolve()


class NativeUpdater:
    def __init__(self, target: dict, *, olympus_version: str | None = None, dry_run: bool = False):
        self.target = target
        self.olympus_version = olympus_version
        self.source = required_path('HERMES_AGENT_DIR')
        # Keep the selected venv executable spelling: resolving its symlink loses the environment.
        self.python = Path(os.environ.get('HERMES_PYTHON', ''))
        self.home = required_path('HERMES_HOME')
        self.state = required_path('OLYMPUS_DISPATCH_HOME')
        broad = {Path('/'), Path('/Users'), Path('/home'), Path('/root'), Path.home().resolve()}
        if self.home in broad or self.state in broad or self.home == self.state:
            raise ValueError('Hermes and Olympus require separate dedicated state directories.')
        status_value = os.environ.get('OLYMPUS_HERMES_UPDATE_STATUS_FILE')
        self.status_path = required_path('OLYMPUS_HERMES_UPDATE_STATUS_FILE') if status_value else self.state / 'updater' / 'hermes-operation.json'
        self.operation = {'id': 'dry-run'} if dry_run else json.loads(self.status_path.read_text())
        self.selection_path = self.state / 'updater' / 'hermes-selected-runtime.json'
        plist_value = os.environ.get('OLYMPUS_HERMES_UPDATER_PLIST')
        selection = None
        if plist_value:
            plist = required_path('OLYMPUS_HERMES_UPDATER_PLIST')
            if plist.stat().st_mode & 0o022: raise ValueError('The selected LaunchAgent must be protected.')
            environment = plistlib.loads(plist.read_bytes()).get('EnvironmentVariables', {})
            if Path(environment.get('HERMES_HOME', '')).resolve() != self.home or Path(environment.get('OLYMPUS_DISPATCH_HOME', '')).resolve() != self.state:
                raise ValueError('The selected LaunchAgent belongs to another installation.')
            selection = {'sourcePath': environment.get('HERMES_AGENT_DIR'), 'pythonPath': environment.get('HERMES_PYTHON')}
        elif self.selection_path.exists():
            selection = json.loads(self.selection_path.read_text())
            if selection.get('hermesHome') != str(self.home): raise ValueError('The saved runtime belongs to another installation.')
        if selection:
            if not all(isinstance(selection.get(key), str) and Path(selection[key]).is_absolute() for key in ('sourcePath', 'pythonPath')):
                raise ValueError('The selected runtime paths are invalid.')
            self.source = Path(selection['sourcePath']).resolve()
            self.python = Path(selection['pythonPath'])
        self.marker = self.state / '.hermes-update-in-progress'
        self.restart_command = validate_command(os.environ.get('OLYMPUS_HERMES_UPDATER_RESTART_COMMAND', ''))
        self.token = os.environ.get('OLYMPUS_MAINTENANCE_TOKEN', '')
        self.base = os.environ.get('OLYMPUS_HERMES_UPDATER_BASE_URL', 'http://127.0.0.1:6969').rstrip('/')
        self.safe_environment = {key: value for key, value in os.environ.items() if key in {'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT', 'SSL_CERT_FILE', 'SSL_CERT_DIR'}}
        self.original_revision = ''
        self.candidate: Path | None = None
        self.own_marker = False
        self.stop_attempted = False
        self.stopped = False
        self.backup_path: Path | None = None
        self.switched = False
        self.drained = False
        self.resuming = False

    def phase(self, phase: str, message: str) -> None:
        self.operation.update(phase=phase, message=message, updatedAt=int(time.time() * 1000))
        atomic_json(self.status_path, self.operation)

    def command(self, arguments: list[str], *, env: dict | None = None) -> str:
        # Upstream dependency logs can contain URLs/credentials; never forward them to status/logs.
        with tempfile.TemporaryFile() as output:
            result = subprocess.run(arguments, env=self.safe_environment if env is None else env, stdin=subprocess.DEVNULL, stdout=output, stderr=output)
            if result.returncode:
                raise RuntimeError('A native update preparation command failed.')
            output.seek(0)
            data = output.read(65537)
            if len(data) > 65536: raise RuntimeError('Native update command output exceeded its safe limit.')
            return data.decode('utf-8', errors='replace').strip()

    def maintenance(self, action: str) -> dict:
        request = urllib.request.Request(self.base + '/api/maintenance/' + action,
            method='GET' if action in {'status', 'hermes/check'} else 'POST',
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'},
            data=None if action in {'status', 'hermes/check'} else b'{}')
        with urllib.request.urlopen(request, timeout=15) as response:
            data = response.read(65537)
        if len(data) > 65536:
            raise RuntimeError('Maintenance response is invalid.')
        result = json.loads(data)
        if not isinstance(result, dict):
            raise RuntimeError('Maintenance response is invalid.')
        return result

    def check_olympus_version(self) -> None:
        if self.olympus_version is None: return
        request = urllib.request.Request(self.base + '/api/version')
        with urllib.request.urlopen(request, timeout=15) as response:
            data = response.read(65537)
        if len(data) > 65536 or json.loads(data).get('version') != self.olympus_version:
            raise ValueError('The running Olympus release does not match the approved Hermes target.')

    def validate(self) -> None:
        url = urllib.parse.urlsplit(self.base)
        if url.scheme != 'http' or url.hostname not in {'127.0.0.1', 'localhost', '::1'} or url.username or url.password or url.path or url.query or url.fragment:
            raise ValueError('Native maintenance must use the selected local loopback service.')
        self.check_olympus_version()
        if os.environ.get('OLYMPUS_HERMES_UPDATER_EXCLUSIVE') != '1':
            raise ValueError('Native updates require a dedicated Hermes profile home for this Olympus installation.')
        self.uv = validate_command(os.environ.get('OLYMPUS_HERMES_UPDATER_UV') or shutil.which('uv') or '')
        if not self.token or not self.python.is_absolute() or not os.access(self.python, os.X_OK):
            raise ValueError('Native update maintenance or Python configuration is incomplete.')
        if Path('/etc/hermes/image-provenance.json').exists() or Path('/.dockerenv').exists():
            raise ValueError('Image-managed Hermes must be updated through deployment.')
        if not self.source.is_dir() or not (self.source / '.git').exists() or not (self.source / 'run_agent.py').is_file():
            raise ValueError('The selected Hermes source is not a Git installation.')
        if not self.home.is_dir() or not self.state.is_dir() or self.source == self.home or self.source == self.state:
            raise ValueError('The selected native paths are invalid.')
        if self.marker.exists():
            raise ValueError('An interrupted Hermes update requires local recovery.')
        environment = {**self.safe_environment, 'GIT_TERMINAL_PROMPT': '0', 'GIT_OPTIONAL_LOCKS': '0', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
        self.git_environment = environment
        self.original_revision = self.command(['git', '-C', str(self.source), 'rev-parse', '--verify', 'HEAD'], env=environment)
        if len(self.original_revision) != 40:
            raise ValueError('The installed Hermes revision is unknown.')
        if self.command(['git', '-C', str(self.source), '-c', 'core.fsmonitor=false', 'status', '--porcelain', '--untracked-files=normal'], env=environment):
            raise ValueError('The selected Hermes source has local changes.')
        # The new code must never be activated while another native gateway/CLI owns this source.
        processes = self.command(['ps', '-axo', 'pid=,command='])
        for line in processes.splitlines():
            fields = line.strip().split(None, 1)
            if len(fields) != 2 or fields[0] == str(os.getpid()):
                continue
            command = fields[1]
            if str(self.source) in command and 'hermes_worker.py' not in command and 'hermes_native_update.py' not in command:
                raise ValueError('Another process is using the selected Hermes installation.')

    def prepare(self) -> Path:
        self.phase('preparing', 'Preparing the approved Hermes runtime in a separate directory.')
        releases = self.state / 'updater' / 'hermes-releases'
        releases.mkdir(parents=True, exist_ok=True, mode=0o700)
        candidate = releases / (self.target['revision'] + '-' + self.operation['id'])
        candidate.mkdir(mode=0o700)
        self.candidate = candidate
        self.command(['git', 'init', '-q', str(candidate)], env=self.git_environment)
        self.command(['git', '-C', str(candidate), '-c', 'core.hooksPath=/dev/null', 'fetch', '--depth=1', 'https://github.com/NousResearch/hermes-agent.git', self.target['revision']], env=self.git_environment)
        self.command(['git', '-C', str(candidate), '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', 'FETCH_HEAD'], env=self.git_environment)
        if self.command(['git', '-C', str(candidate), 'rev-parse', 'HEAD'], env=self.git_environment) != self.target['revision']:
            raise RuntimeError('Candidate Hermes revision did not match the approved target.')
        python = candidate / '.venv' / 'bin' / 'python'
        with tempfile.TemporaryDirectory(prefix='olympus-hermes-build-') as build_home:
            environment = {**self.safe_environment, 'HOME': build_home, 'HERMES_HOME': build_home, 'UV_PYTHON_DOWNLOADS': 'never', 'UV_PROJECT_ENVIRONMENT': str(candidate / '.venv')}
            self.command([str(self.python), '-m', 'venv', str(candidate / '.venv')], env=environment)
            self.command([self.uv, 'sync', '--frozen', '--extra', 'all', '--no-dev', '--project', str(candidate), '--python', str(self.python)], env=environment)
        # Only this repository's bridge code is executed. The candidate imports use disposable state.
        worker = Path(os.environ.get('OLYMPUS_HERMES_WORKER_DIR', str(Path(__file__).resolve().parents[2] / 'server' / 'workers')))
        if not (worker / 'hermes_worker.py').is_file():
            worker = Path(__file__).resolve().parents[2] / 'dist' / 'server' / 'server' / 'workers'
        if not (worker / 'hermes_worker.py').is_file():
            raise RuntimeError('Olympus worker preflight assets are unavailable.')
        with tempfile.TemporaryDirectory(prefix='olympus-hermes-preflight-') as directory:
            environment = {key: value for key, value in os.environ.items() if key in {'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT'}}
            environment.update(HOME=directory, HERMES_HOME=directory, HERMES_AGENT_DIR=str(candidate), HERMES_PYTHON=str(python), OLYMPUS_DISPATCH_HOME=directory, PYTHONPATH=str(worker))
            self.command([str(python), '-c', 'import hermes_worker; hermes_worker._ensure_imports()'], env=environment)
        return candidate

    def drain(self) -> None:
        self.phase('draining', 'Waiting for active Olympus work to finish.')
        if self.maintenance('status').get('draining') is True:
            raise ValueError('Another maintenance operation is already draining this installation.')
        if self.maintenance('drain').get('changed') is not True:
            raise ValueError('Another maintenance operation acquired the installation.')
        self.drained = True
        for _ in range(120):
            status = self.maintenance('hermes/check')
            if status.get('ready') is True:
                self.check_olympus_version()
                runtime = status.get('runtime') or {}
                if runtime.get('sourcePath') != str(self.source) or runtime.get('revision') != self.original_revision:
                    raise ValueError('The running installation no longer matches the selected Hermes runtime.')
                return
            time.sleep(1)
        raise RuntimeError('Active work did not drain; update cancelled without stopping tasks.')

    def backup(self) -> Path:
        self.phase('backing_up', 'Backing up Olympus and Hermes data before switching runtimes.')
        directory = self.state / 'backups' / ('hermes-' + self.operation['id'])
        directory.mkdir(parents=True, mode=0o700)
        archive_path = directory / 'state.tar.gz'
        excluded = {self.source.resolve(), (self.state / 'backups').resolve(), (self.state / 'updater').resolve()}
        database = Path(os.environ.get('DB_PATH', str(self.state / 'data' / 'olympus-dispatch.db'))).resolve()
        database_copy = directory / 'olympus-dispatch.db'
        if database.is_file():
            with sqlite3.connect(str(database)) as source, sqlite3.connect(str(database_copy)) as destination:
                source.backup(destination)
                if destination.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError('The Olympus backup did not pass verification.')
            database_copy.chmod(0o600)
        def add_tree(archive: tarfile.TarFile, root: Path, label: str) -> None:
            def include(info: tarfile.TarInfo) -> tarfile.TarInfo | None:
                relative = Path(info.name).relative_to(label)
                path = root / relative
                if path != root and path.resolve() in {self.state, self.home}: return None
                if path.is_socket() or path.resolve() in excluded or path.resolve() == database or path.name in {'olympus-dispatch.db-wal', 'olympus-dispatch.db-shm', '.hermes-update-in-progress'}:
                    return None
                return info
            archive.add(root, arcname=label, filter=include)
        descriptor = os.open(archive_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as file, tarfile.open(fileobj=file, mode='w:gz') as archive:
            add_tree(archive, self.state, 'olympus')
            add_tree(archive, self.home, 'hermes')
            if database_copy.exists():
                archive.add(database_copy, arcname='database/olympus-dispatch.db')
        archive_path.chmod(0o600)
        # A complete archive must be readable before the service selection changes.
        with tarfile.open(archive_path) as archive:
            archive.getmembers()
        atomic_json(directory / 'runtime.json', {'sourcePath': str(self.source), 'pythonPath': str(self.python), 'revision': self.original_revision, 'targetRevision': self.target['revision'], 'sha256': self.digest(archive_path)})
        return archive_path

    @staticmethod
    def digest(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        return digest.hexdigest()

    def restore(self, archive_path: Path) -> None:
        receipt = json.loads((archive_path.parent / 'runtime.json').read_text())
        if receipt.get('sha256') != self.digest(archive_path):
            raise RuntimeError('The recovery archive changed; no data was restored.')
        # Validate and stage the complete archive before removing any live data.
        with tempfile.TemporaryDirectory(prefix='restore-', dir=archive_path.parent) as directory:
            stage = Path(directory)
            with tarfile.open(archive_path) as archive:
                for member in archive:
                    name = PurePosixPath(member.name)
                    if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0] not in {'olympus', 'hermes', 'database'}:
                        raise RuntimeError('The recovery archive contains an invalid path.')
                    target = stage.joinpath(*name.parts)
                    if any(parent.is_symlink() for parent in target.parents if parent != stage.parent):
                        raise RuntimeError('The recovery archive traverses a link.')
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    if member.isdir():
                        target.mkdir(exist_ok=True, mode=member.mode & 0o777)
                    elif member.isfile():
                        with archive.extractfile(member) as source, target.open('xb') as destination:
                            shutil.copyfileobj(source, destination)
                        target.chmod(member.mode & 0o777)
                    elif member.issym():
                        target.symlink_to(member.linkname)
                    elif member.islnk():
                        link = PurePosixPath(member.linkname)
                        if link.is_absolute() or '..' in link.parts or not link.parts or link.parts[0] not in {'olympus', 'hermes', 'database'}:
                            raise RuntimeError('The recovery archive contains an invalid hard link.')
                        original = stage.joinpath(*link.parts)
                        if original.is_symlink() or not original.is_file() or any(parent.is_symlink() for parent in original.parents):
                            raise RuntimeError('The recovery archive hard link is unavailable.')
                        os.link(original, target)
                    else:
                        raise RuntimeError('The recovery archive contains an unsupported file.')
            protected = {self.source, self.state / 'backups', self.state / 'updater', self.marker, self.home, self.state}
            def clear(path: Path) -> None:
                if path in protected or path.resolve() in protected:
                    return
                if path.is_dir() and not path.is_symlink() and any(item.is_relative_to(path) for item in protected):
                    for child in path.iterdir(): clear(child)
                elif path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path)
                else:
                    path.unlink(missing_ok=True)
            for label, root in (('olympus', self.state), ('hermes', self.home)):
                if not (stage / label).is_dir(): raise RuntimeError('The recovery archive is incomplete.')
                for child in root.iterdir(): clear(child)
                shutil.copytree(stage / label, root, dirs_exist_ok=True, symlinks=True)
            database_copy = stage / 'database' / 'olympus-dispatch.db'
            if database_copy.exists():
                database = Path(os.environ.get('DB_PATH', str(self.state / 'data' / 'olympus-dispatch.db')))
                database.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                for suffix in ('', '-wal', '-shm'):
                    Path(str(database) + suffix).unlink(missing_ok=True)
                shutil.copy2(database_copy, database)

    def stop(self, expected: Path) -> None:
        environment = os.environ.copy()
        environment.update(OLYMPUS_HERMES_SERVICE_ACTION='stop', OLYMPUS_HERMES_EXPECTED_SOURCE=str(expected), OLYMPUS_HERMES_CANDIDATE_SOURCE=str(expected), OLYMPUS_HERMES_CANDIDATE_PYTHON=str(self.python))
        self.command([self.restart_command], env=environment)
        # Node's exit alone is not enough: wait until its selected worker processes
        # have also exited before taking or restoring a filesystem snapshot.
        for _ in range(30):
            processes = self.command(['ps', '-axo', 'pid=,command='])
            active = []
            for line in processes.splitlines():
                fields = line.strip().split(None, 1)
                if len(fields) != 2 or fields[0] == str(os.getpid()): continue
                command = fields[1]
                if any(helper in command for helper in ('hermes_native_update.py', 'update_runner.py', 'hermes_macos_restart.py')): continue
                if str(expected) in command or (expected == self.source and str(self.python) in command): active.append(fields[0])
            if not active: return
            time.sleep(1)
        raise RuntimeError('Selected Hermes processes are still running; state was not touched.')

    def restart(self, source: Path, python: Path, expected: Path) -> None:
        environment = os.environ.copy()
        environment.update(OLYMPUS_HERMES_SERVICE_ACTION='restart', OLYMPUS_HERMES_EXPECTED_SOURCE=str(expected), OLYMPUS_HERMES_CANDIDATE_SOURCE=str(source), OLYMPUS_HERMES_CANDIDATE_PYTHON=str(python))
        self.command([self.restart_command], env=environment)

    def verify(self, revision: str) -> None:
        for _ in range(60):
            try:
                result = self.maintenance('hermes/check')
                runtime = result.get('runtime') or {}
                if result.get('ready') is True and runtime.get('available') is True and runtime.get('revision') == revision:
                    return
            except Exception:
                pass
            time.sleep(1)
        raise RuntimeError('The selected Hermes runtime did not pass startup verification.')

    def save_selection(self, source: Path, python: Path) -> None:
        atomic_json(self.selection_path, {'sourcePath': str(source), 'pythonPath': str(python), 'hermesHome': str(self.home)})

    def fence(self) -> None:
        try:
            descriptor = os.open(self.marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            if json.loads(self.marker.read_text()).get('operationId') != self.operation['id']:
                raise RuntimeError('Another operation owns the admission fence.')
        else:
            self.own_marker = True
            with os.fdopen(descriptor, 'w') as stream:
                json.dump({'operationId': self.operation['id']}, stream)
                stream.flush()
                os.fsync(stream.fileno())

    def resume(self) -> None:
        self.resuming = True
        if json.loads(self.marker.read_text()).get('operationId') != self.operation['id']:
            raise RuntimeError('Another operation owns the admission fence.')
        self.marker.unlink()
        self.maintenance('cancel')
        self.drained = False

    def run(self) -> None:
        try:
            self.validate()
            candidate = self.prepare()
            self.candidate = candidate
            self.drain()
            self.fence()
            self.stop_attempted = True
            self.stop(self.source)
            self.stopped = True
            self.backup_path = self.backup()
            self.phase('installing', 'Switching this Olympus installation to the approved runtime.')
            self.switched = True  # Restart can fail after it changes the service selection.
            self.restart(candidate, candidate / '.venv' / 'bin' / 'python', self.source)
            self.phase('verifying', 'Verifying the selected Hermes runtime before accepting work.')
            self.verify(self.target['revision'])
            self.save_selection(candidate, candidate / '.venv' / 'bin' / 'python')
            self.resume()
            self.phase('completed', 'Hermes was updated and the selected Olympus installation is ready.')
        except Exception:
            if self.resuming:
                # Cancel may have succeeded before its reply was lost. Never switch code
                # after admission may have resumed; retain the runtime and fence recovery.
                self.fence()
                try: self.maintenance('drain')
                except Exception: pass
                self.phase('interrupted', 'The runtime was verified, but resuming Olympus needs local confirmation.')
            elif self.stopped:
                try:
                    if self.switched:
                        self.stop(self.candidate)
                        self.restore(self.backup_path)
                    self.restart(self.source, self.python, self.candidate if self.switched else self.source)
                    self.verify(self.original_revision)
                    self.save_selection(self.source, self.python)
                    self.resume()
                    self.phase('rolled_back' if self.switched else 'failed', 'The candidate could not be verified. The previous runtime and saved state were restored.' if self.switched else 'The update stopped before changing runtimes. The previous runtime is available.')
                except Exception:
                    if self.resuming:
                        self.fence()
                        try: self.maintenance('drain')
                        except Exception: pass
                    self.phase('interrupted', 'Runtime recovery needs local attention. Olympus remains paused; backups were retained.')
            elif self.stop_attempted:
                self.phase('interrupted', 'Service shutdown could not be confirmed. Olympus remains fenced for local recovery.')
            else:
                try:
                    if self.own_marker: self.marker.unlink(missing_ok=True)
                    if self.drained: self.maintenance('cancel')
                    self.phase('failed', 'The update stopped before changing the selected runtime.')
                except Exception:
                    self.phase('interrupted', 'The update needs local recovery before Olympus can resume.')
            raise RuntimeError('The Hermes update did not complete.') from None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--olympus-version', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    try:
        if not VERSION_RE.fullmatch(args.olympus_version): raise ValueError('Invalid Olympus version.')
        if args.dry_run:
            target = load_release_target(args.olympus_version)
            updater = NativeUpdater(target, olympus_version=args.olympus_version, dry_run=True)
            updater.validate()
            print(json.dumps({'mode': 'dry-run', 'sourcePath': str(updater.source), 'pythonPath': str(updater.python), 'hermesHome': str(updater.home), 'stateHome': str(updater.state), 'targetVersion': target['version'], 'targetRevision': target['revision']}))
            return 0
        request = json.loads(required_path('OLYMPUS_HERMES_UPDATE_REQUEST_FILE').read_text())
        target = validate_target(request.get('target'))
        if request.get('repository') != 'digitalchili/olympus' or request.get('olympusVersion') != args.olympus_version or target != load_release_target(args.olympus_version):
            raise ValueError('The approved release target has changed.')
        NativeUpdater(target, olympus_version=args.olympus_version).run()
        return 0
    except Exception:
        print('The native Hermes update did not complete. Check the local updater status.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
