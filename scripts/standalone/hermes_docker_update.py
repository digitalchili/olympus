#!/usr/bin/env python3
"""Selected-installation Docker/Dokploy Hermes updater. Never runs inside Olympus.

Dokploy mode supports an explicitly selected raw Compose service with automatic
and isolated deployments disabled. The host helper owns the single-writer
transaction and updates Dokploy's saved image variable as well as its local env.
"""
from __future__ import annotations
import argparse
import copy
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import time
import urllib.parse
import urllib.request
from typing import Callable
from update_runner import atomic_json, load_release_target, validate_target


class UpdateError(Exception):
    pass


def run(arguments: list[str], *, cwd: Path | None = None, timeout: int | None = 120) -> str:
    try:
        result = subprocess.run(arguments, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, timeout=timeout, check=False)
        if result.returncode:
            raise UpdateError('An installation update step failed. See the private host configuration and recovery guide.')
        return result.stdout
    except (OSError, subprocess.TimeoutExpired) as error:
        raise UpdateError('An installation update step could not finish.') from error


def replace_image(contents: str, image: str) -> str:
    if len(re.findall(r'^OLYMPUS_DISPATCH_IMAGE=', contents, re.M)) != 1:
        raise UpdateError('The selected Compose environment must contain exactly one OLYMPUS_DISPATCH_IMAGE.')
    return re.sub(r'^OLYMPUS_DISPATCH_IMAGE=.*$', lambda _: 'OLYMPUS_DISPATCH_IMAGE=' + image, contents, flags=re.M)


def selected_state(info: dict, project: str, service: str) -> tuple[str, str]:
    labels = info.get('Config', {}).get('Labels', {}) or {}
    if labels.get('com.docker.compose.project') != project or labels.get('com.docker.compose.service') != service:
        raise UpdateError('The container does not belong to the selected installation.')
    environment = dict(item.split('=', 1) for item in info['Config'].get('Env', []) if '=' in item)
    homes = (environment.get('HERMES_HOME', ''), environment.get('OLYMPUS_DISPATCH_HOME', ''))
    mounts = info.get('Mounts', [])
    for home in homes:
        path = PurePosixPath(home)
        if not path.is_absolute() or home in {'/', '/opt', '/home', '/root'} or '..' in path.parts:
            raise UpdateError('Both Hermes and Olympus must have explicit dedicated persistent state paths.')
        owners = [mount for mount in mounts if mount.get('RW') and mount.get('Type') in {'volume', 'bind'}
                  and (home == mount['Destination'] or home.startswith(mount['Destination'].rstrip('/') + '/'))]
        if len(owners) != 1 or any(mount['Destination'].startswith(home.rstrip('/') + '/') for mount in mounts):
            raise UpdateError('State volume ownership is missing or ambiguous.')
    return homes


def validate_dokploy(info: dict, project: str) -> None:
    if (info.get('appName') != project or info.get('sourceType') != 'raw'
            or info.get('composeType') != 'docker-compose' or info.get('autoDeploy') is not False
            or info.get('isolatedDeployment') is not False
            or '${OLYMPUS_DISPATCH_IMAGE}' not in str(info.get('composeFile', ''))):
        raise UpdateError('Dokploy must use the selected raw Compose project, an image variable, and manual single-instance deployment.')
    replace_image(info.get('env', ''), 'validation-only')


def recover_candidate(*, stop: Callable, restore: Callable, start: Callable, verify: Callable, release: Callable) -> None:
    # A failed stop must leave the backup untouched. Never restore under a writer.
    stop()
    restore()
    start()
    verify()
    release()


API_SCRIPT = r'''
const path = process.argv[1], method = process.argv[2];
const token = process.env.OLYMPUS_MAINTENANCE_TOKEN;
if (!token) process.exit(2);
fetch(`http://127.0.0.1:${process.env.PORT || 6969}${path}`, {
 method, headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(30000)
}).then(async r => { if (!r.ok) process.exit(3); console.log(JSON.stringify(await r.json())); }).catch(() => process.exit(4));
'''
FENCE_SCRIPT = r'''
from pathlib import Path
import sys
p = Path(sys.argv[1]) / '.hermes-update-in-progress'
if sys.argv[2] == 'create':
 try:
  with p.open('x') as stream: stream.write(sys.argv[3])
 except FileExistsError:
  assert p.read_text() == sys.argv[3]
 p.chmod(0o600)
else:
 assert p.read_text() == sys.argv[3]
 p.unlink()
'''
# Candidate starts without production state, provider credentials or network.
PREFLIGHT_SCRIPT = r'''
import json, os, sys
sys.path.insert(0, '/opt/olympus-dispatch/dist/server/server/workers')
os.environ['HERMES_HOME'] = '/tmp/olympus-hermes-preflight'
os.makedirs(os.environ['HERMES_HOME'], exist_ok=True)
import hermes_worker
hermes_worker._ensure_imports()
from hermes_runtime import get_runtime
from pathlib import Path
runtime = get_runtime(Path('/opt/hermes'))
assert runtime['available'] and runtime['revision'] == sys.argv[1]
print(json.dumps(json.load(open('/opt/olympus-dispatch/dist/server/server/hermes-runtime.json'))))
'''
ARCHIVE_SCRIPT = r'''
import hashlib, json, os, shutil, sys, tarfile
from pathlib import Path
roots = [Path(p) for p in json.loads(sys.argv[1])]
olympus = Path(sys.argv[2])
excluded = [olympus / 'backups', olympus / 'updater', olympus / '.hermes-update-in-progress']
def excluded_path(p): return any(p == x or x in p.parents for x in excluded)
archive = Path('/backup/state.tar')
def digest():
 value = hashlib.sha256()
 with archive.open('rb') as stream:
  for chunk in iter(lambda: stream.read(1024 * 1024), b''): value.update(chunk)
 return value.hexdigest()
def validate():
 with tarfile.open(archive) as tar:
  for entry in tar:
   path = Path('/') / entry.name
   if Path(entry.name).is_absolute() or '..' in Path(entry.name).parts or not any(path == root or root in path.parents for root in roots):
    raise ValueError('Invalid archive path')
   if not (entry.isfile() or entry.isdir() or entry.issym()): raise ValueError('Unsupported archive entry')
   # Reject unsupported links before candidate startup or removing current data.
   tarfile.data_filter(entry, '/')
   if entry.isfile():
    stream = tar.extractfile(entry)
    while stream.read(1024 * 1024): pass
if sys.argv[3] == 'backup':
 os.umask(0o077)
 with tarfile.open(archive, 'w') as tar:
  def filt(item):
   path = Path('/') / item.name
   return None if excluded_path(path) or not (item.isfile() or item.isdir() or item.issym()) else item
  for root in roots: tar.add(root, arcname=str(root).lstrip('/'), filter=filt)
 assert archive.stat().st_size > 0
 validate()
 archive.with_suffix('.sha256').write_text(digest())
else:
 if archive.with_suffix('.sha256').read_text() != digest(): raise ValueError('The archive changed')
 validate()
 def clear(path):
  if excluded_path(path): return
  if any(path in x.parents for x in excluded) and path.is_dir() and not path.is_symlink():
   for child in path.iterdir(): clear(child)
  elif path.is_dir() and not path.is_symlink(): shutil.rmtree(path)
  else: path.unlink(missing_ok=True)
 for root in roots:
  for child in root.iterdir(): clear(child)
 def restore_filter(entry, destination):
  safe = tarfile.data_filter(entry, destination)
  # Extraction runs as root, while Olympus runs as UID 10000. Keep the
  # original numeric ownership and private modes after validating paths/links.
  return safe.replace(uid=entry.uid, gid=entry.gid, uname=None, gname=None, mode=entry.mode & 0o777)
 with tarfile.open(archive) as tar: tar.extractall('/', filter=restore_filter, numeric_owner=True)
'''


class DockerUpdate:
    def __init__(self, version: str):
        if os.environ.get('OLYMPUS_HERMES_UPDATER_EXCLUSIVE') != '1':
            raise UpdateError('Confirm exclusive ownership of the selected installation before enabling Hermes updates.')
        self.request = json.loads(Path(os.environ['OLYMPUS_HERMES_UPDATE_REQUEST_FILE']).read_text())
        self.status_file = Path(os.environ['OLYMPUS_HERMES_UPDATE_STATUS_FILE'])
        self.operation = json.loads(self.status_file.read_text())
        self.version = version
        self.target = validate_target(self.request['target'])
        if (self.request.get('repository') != 'digitalchili/olympus' or self.request.get('olympusVersion') != version
                or not re.fullmatch(r'\d+\.\d+\.\d+', version) or load_release_target(version) != self.target):
            raise UpdateError('The requested release is not approved.')
        self.read_selection()
        self.backup = self.status_file.parent / ('backup-' + self.operation['id'])
        if ',' in str(self.backup): raise UpdateError('The updater state path cannot contain a comma.')
        self.backup.mkdir(mode=0o700)
        self.old_revision = None
        self.new_image = None
        self.pin = None
        self.fenced = False
        self.stopped = False
        self.backed_up = False
        self.changed = False
        self.released = False
        self.configuration_changed = False
        self.drain_requested = False
        self.owns_drain = False

    def read_selection(self) -> None:
        """Read the explicit local selection without creating an update transaction."""
        self.directory = Path(os.environ['OLYMPUS_UPDATER_COMPOSE_DIR']).resolve(strict=True)
        self.project = os.environ['OLYMPUS_UPDATER_COMPOSE_PROJECT']
        self.service = os.environ.get('OLYMPUS_UPDATER_SERVICE', 'olympus-dispatch')
        if not all(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,62}', value) for value in [self.project, self.service]):
            raise UpdateError('Invalid selected Compose service.')
        self.env_file = self.directory / '.env'
        self.private_environment()
        self.compose_file = self.directory / os.environ.get('OLYMPUS_UPDATER_COMPOSE_FILE', 'docker-compose.yml')
        if self.compose_file.resolve().parent != self.directory or not self.compose_file.is_file():
            raise UpdateError('Select one Compose file inside the installation directory.')
        self.compose = ['docker', 'compose', '--project-directory', str(self.directory), '--env-file', str(self.env_file), '-p', self.project, '-f', str(self.compose_file)]
        self.old_compose = self.compose_file.read_bytes()
        self.old_env = self.env_file.read_text()
        self.expected_env = self.old_env
        replace_image(self.old_env, 'validation-only')
        self.mode = os.environ.get('OLYMPUS_HERMES_UPDATER_MODE', 'docker')
        if self.mode not in {'docker', 'dokploy'}: raise UpdateError('Invalid Docker updater mode.')
        self.dokploy = None
        if self.mode == 'dokploy':
            parsed = urllib.parse.urlparse(os.environ['OLYMPUS_DOKPLOY_URL'])
            if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.query or parsed.fragment:
                raise UpdateError('Dokploy requires an explicit HTTPS dashboard URL.')
            key_file = Path(os.environ['OLYMPUS_DOKPLOY_API_KEY_FILE'])
            if key_file.stat().st_mode & 0o077: raise UpdateError('The Dokploy key file must be private.')
            self.dokploy_key = key_file.read_text().strip()
            self.dokploy_url = os.environ['OLYMPUS_DOKPLOY_URL'].rstrip('/')
            self.compose_id = os.environ['OLYMPUS_DOKPLOY_COMPOSE_ID']
            self.dokploy = self.dokploy_api('compose.one?composeId=' + urllib.parse.quote(self.compose_id, safe=''))
            validate_dokploy(self.dokploy, self.project)
        self.expected_dokploy = copy.deepcopy(self.dokploy)
        self.old_id = self.container()
        self.old_info = self.inspect(self.old_id)
        self.hermes_home, self.olympus_home = selected_state(self.old_info, self.project, self.service)
        self.roots = sorted(set([self.hermes_home, self.olympus_home]), key=len)
        self.roots = [root for root in self.roots if not any(root.startswith(parent.rstrip('/') + '/') for parent in self.roots if parent != root)]
        self.old_image = self.old_info['Image']
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', self.old_image): raise UpdateError('The current image identity is unavailable.')
        self.rollback_pin = self.old_image
        if self.mode == 'dokploy':
            metadata = json.loads(self.docker('image', 'inspect', self.old_image))[0]
            digests = [value for value in metadata.get('RepoDigests', []) if re.fullmatch(r'ghcr.io/digitalchili/olympus@sha256:[0-9a-f]{64}', value)]
            if metadata.get('Id') != self.old_image or len(digests) != 1:
                raise UpdateError('Dokploy rollback requires the current official image’s immutable registry digest.')
            self.rollback_pin = digests[0]
        self.owned_id, self.owned_image = self.old_id, self.old_image
        self.expected_compose = json.loads(run(self.compose + ['config', '--format', 'json'], cwd=self.directory))
        service = self.expected_compose.get('services', {}).get(self.service, {})
        if service.get('image') != self.old_info['Config'].get('Image') or service.get('scale', 1) != 1 or service.get('deploy', {}).get('replicas', 1) != 1:
            raise UpdateError('The saved Compose service does not match the selected single container.')
        environment = service.get('environment', {})
        if (environment.get('HERMES_HOME'), environment.get('OLYMPUS_DISPATCH_HOME')) != (self.hermes_home, self.olympus_home):
            raise UpdateError('The saved Compose state paths do not match the selected container.')
        for root in self.roots:
            mounts = [mount for mount in service.get('volumes', []) if root == mount.get('target') or root.startswith(str(mount.get('target', '')).rstrip('/') + '/')]
            if len(mounts) != 1: raise UpdateError('The saved Compose state volumes are ambiguous.')
            mount = mounts[0]
            source = self.expected_compose.get('volumes', {}).get(mount.get('source'), {}).get('name') if mount.get('type') == 'volume' else mount.get('source')
            if mount.get('read_only') or not any(old.get('Destination') == mount['target'] and old.get('Type') == mount.get('type') and old.get('Name' if mount.get('type') == 'volume' else 'Source') == source for old in self.old_info['Mounts']):
                raise UpdateError('The saved Compose state volume differs from the selected container.')

    def private_environment(self) -> None:
        if self.env_file.is_symlink() or not self.env_file.is_file() or self.env_file.stat().st_mode & 0o077:
            raise UpdateError('The selected Compose environment must be a private regular file (mode 600).')

    def assert_selected(self) -> dict:
        if self.container() != self.owned_id: raise UpdateError('The selected service changed during the update.')
        info = self.inspect(self.owned_id)
        if info.get('Id') != self.owned_id or info.get('Image') != self.owned_image or info.get('Mounts') != self.old_info.get('Mounts') or selected_state(info, self.project, self.service) != (self.hermes_home, self.olympus_home):
            raise UpdateError('The selected service or its state volumes changed during the update.')
        return info

    def assert_configuration(self) -> None:
        self.private_environment()
        if self.compose_file.read_bytes() != self.old_compose or self.env_file.read_text() != self.expected_env:
            raise UpdateError('Compose settings changed during the update. Recovery needs review.')
        if json.loads(run(self.compose + ['config', '--format', 'json'], cwd=self.directory)) != self.expected_compose:
            raise UpdateError('Resolved Compose settings changed during the update. Recovery needs review.')
        if self.dokploy is not None:
            current = self.dokploy_api('compose.one?composeId=' + urllib.parse.quote(self.compose_id, safe=''))
            validate_dokploy(current, self.project)
            fields = ('composeId', 'appName', 'sourceType', 'composeType', 'autoDeploy', 'isolatedDeployment', 'composeFile', 'env')
            if any(current.get(key) != self.expected_dokploy.get(key) for key in fields):
                raise UpdateError('Dokploy settings changed during the update. Recovery needs review.')

    def report(self, phase: str, message: str) -> None:
        self.operation.update(phase=phase, message=message, updatedAt=int(time.time() * 1000))
        atomic_json(self.status_file, self.operation)

    def docker(self, *args: str, timeout: int | None = 120) -> str:
        return run(['docker', *args], timeout=timeout)

    def inspect(self, container: str) -> dict:
        return json.loads(self.docker('inspect', container))[0]

    def container(self) -> str:
        values = self.docker('ps', '-aq', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + self.project,
                             '--filter', 'label=com.docker.compose.service=' + self.service).split()
        if len(values) != 1: raise UpdateError('Expected exactly one container for the selected service.')
        return values[0]

    def api(self, path: str, method: str = 'GET') -> dict:
        self.assert_selected()
        return json.loads(self.docker('exec', self.owned_id, '/opt/olympus-node/bin/node', '-e', API_SCRIPT, path, method, timeout=40))

    def dokploy_api(self, route: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.dokploy_url + '/api/' + route, data=data,
            headers={'x-api-key': self.dokploy_key, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024: raise UpdateError('Unexpected Dokploy response.')
            return json.loads(raw) if raw else {}
        except Exception as error: raise UpdateError('Dokploy configuration could not be read or saved.') from error

    def assert_exclusive_volumes(self) -> None:
        sources = {m.get('Source') for m in self.old_info['Mounts'] if any(root == m['Destination'] or root.startswith(m['Destination'].rstrip('/') + '/') for root in self.roots)}
        for container in self.docker('ps', '-q').split():
            info = self.inspect(container)
            if info['Id'] == self.old_info['Id']: continue
            if any(m.get('Source') in sources and m.get('RW') for m in info.get('Mounts', [])):
                raise UpdateError('Another container is writing to this installation’s state.')

    def fence(self, action: str) -> None:
        self.assert_selected()
        self.docker('exec', self.owned_id, '/opt/hermes/.venv/bin/python', '-c', FENCE_SCRIPT, self.olympus_home, action, self.operation['id'])

    def archive(self, action: str) -> None:
        if self.assert_selected().get('State', {}).get('Running') is not False:
            raise UpdateError('State can only be backed up or restored while the selected writer is stopped.')
        self.assert_exclusive_volumes()
        self.docker('run', '--rm', '--network', 'none', '--user', '0:0', '--read-only',
                    '--volumes-from', self.owned_id + (':ro' if action == 'backup' else ':rw'),
                    '--mount', 'type=bind,src=' + str(self.backup) + ',dst=/backup' + (',readonly' if action == 'restore' else ''),
                    '--entrypoint', '/opt/hermes/.venv/bin/python', self.new_image, '-c', ARCHIVE_SCRIPT,
                    json.dumps(self.roots), self.olympus_home, action, timeout=None)

    def configure(self, image: str, *, restoring: bool = False) -> None:
        self.assert_configuration()
        contents = replace_image(self.old_env, image)
        if self.dokploy is not None:
            remote_env = replace_image(self.dokploy['env'], image)
            self.dokploy_api('compose.update', {'composeId': self.compose_id, 'env': remote_env})
            self.expected_dokploy['env'] = remote_env
            # A lost/partial remote save is never assumed safe to overwrite.
            self.assert_configuration()
        if self.env_file.read_text() != self.expected_env: raise UpdateError('Compose settings changed during the update. Recovery needs review.')
        # The original is retained privately, but rollback pins the exact old ID.
        # Restoring its mutable tag could otherwise launch the failed candidate.
        temporary = self.env_file.with_name('.env.hermes-update')
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as stream: stream.write(contents); stream.flush(); os.fsync(stream.fileno())
        self.assert_configuration()
        temporary.replace(self.env_file)
        self.expected_env = contents
        self.expected_compose['services'][self.service]['image'] = image
        self.assert_configuration()

    def start(self, expected_image: str) -> None:
        if self.assert_selected().get('State', {}).get('Running') is not False:
            raise UpdateError('The previous container must be stopped before replacement.')
        self.assert_configuration()
        self.assert_exclusive_volumes()
        run(self.compose + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', self.service], cwd=self.directory, timeout=180)
        selected = self.container()
        info = self.inspect(selected)
        if info['Image'] != expected_image: raise UpdateError('The selected service started an unexpected image.')
        self.owned_id, self.owned_image = selected, expected_image
        self.assert_selected()

    def verify(self, revision: str) -> None:
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            try:
                result = self.api('/api/maintenance/hermes/check')
                if result.get('ready') is True and result.get('runtime', {}).get('revision') == revision: return
            except UpdateError: pass
            time.sleep(2)
        raise UpdateError('The replacement Hermes runtime could not be verified.')

    def release(self) -> None:
        self.assert_selected()
        self.assert_configuration()
        # Removing the fence can succeed even if its acknowledgement is lost.
        # Never restore a backup after this boundary.
        self.released = True
        try:
            self.fence('remove')
            self.fenced = False
            self.api('/api/maintenance/cancel', 'POST')
            if self.api('/api/ready').get('ready') is not True: raise UpdateError('The updated installation has not confirmed readiness.')
        except Exception:
            # This also runs when release fails *inside rollback*, where the
            # outer recovery handler must not attempt another state restore.
            try: self.pause_after_release()
            except Exception: pass
            raise UpdateError('Work may have resumed. Check the running installation before recovery.') from None

    def pause_after_release(self) -> None:
        self.assert_selected()
        try:
            self.fence('create'); self.fenced = True
        finally:
            self.api('/api/maintenance/drain', 'POST')

    def execute(self) -> None:
        self.assert_selected()
        self.assert_configuration()
        self.report('preparing', 'Checking the tested container image with disposable state.')
        image = 'ghcr.io/digitalchili/olympus:' + self.version
        self.docker('pull', image, timeout=600)
        metadata = json.loads(self.docker('image', 'inspect', image))[0]
        labels = metadata.get('Config', {}).get('Labels', {})
        if labels.get('org.opencontainers.image.version') != self.version or labels.get('org.opencontainers.image.source') != 'https://github.com/digitalchili/olympus':
            raise UpdateError('The candidate is not the selected Olympus release.')
        self.new_image = metadata['Id']
        digests = [d for d in metadata.get('RepoDigests', []) if re.fullmatch(r'ghcr.io/digitalchili/olympus@sha256:[0-9a-f]{64}', d)]
        if len(digests) != 1: raise UpdateError('The candidate image has no unambiguous immutable digest.')
        self.pin = digests[0]
        result = self.docker('run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/opt/data',
            '--entrypoint', '/opt/hermes/.venv/bin/python', self.new_image, '-c', PREFLIGHT_SCRIPT, self.target['revision'], timeout=120)
        # Hermes import diagnostics can precede the final machine-readable line.
        if validate_target(json.loads(result.strip().splitlines()[-1])) != self.target: raise UpdateError('The image does not contain the approved Hermes runtime.')
        self.assert_selected()
        self.assert_configuration()
        self.assert_exclusive_volumes()
        self.report('draining', 'Waiting for active work to finish. No tasks will be stopped automatically.')
        if self.api('/api/maintenance/status').get('draining') is not False:
            raise UpdateError('The selected installation is already paused for maintenance.')
        self.drain_requested = True
        result = self.api('/api/maintenance/drain', 'POST')
        if result.get('changed') is not True: raise UpdateError('Maintenance ownership could not be confirmed.')
        self.owns_drain = True
        while self.api('/api/maintenance/status').get('activeRuns') != 0: time.sleep(2)
        check = self.api('/api/maintenance/hermes/check')
        if check.get('ready') is not True: raise UpdateError('Background work must finish before Hermes can be updated.')
        self.old_revision = check['runtime']['revision']
        self.fence('create'); self.fenced = True
        self.assert_selected()
        self.assert_configuration()
        self.assert_exclusive_volumes()
        self.docker('stop', '--time=-1', self.old_id, timeout=None); self.stopped = True
        self.report('backing_up', 'Backing up the selected Olympus and Hermes state.')
        atomic_json(self.backup / 'recovery.json', {'oldImage': self.old_image, 'rollbackImage': self.rollback_pin, 'oldRevision': self.old_revision, 'roots': self.roots, 'project': self.project, 'service': self.service})
        descriptor = os.open(self.backup / 'compose.env', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as stream: stream.write(self.old_env)
        if self.dokploy is not None: atomic_json(self.backup / 'dokploy.json', {'env': self.dokploy['env'], 'composeId': self.compose_id})
        self.archive('backup'); self.backed_up = True
        self.report('installing', 'Replacing the selected service while new work remains paused.')
        self.configuration_changed = True
        self.configure(self.pin)
        self.changed = True
        self.start(self.new_image)
        self.report('verifying', 'Verifying Hermes and Olympus before reopening tasks.')
        self.verify(self.target['revision'])
        self.release()
        self.report('completed', 'Hermes was updated and the installation is ready. A private backup was retained.')

    def recover(self) -> None:
        if self.released:
            # A cancel/readiness reply may have been lost after work resumed.
            # Re-pause, retain current state, and require deliberate recovery.
            self.pause_after_release()
            raise UpdateError('Work may have resumed. Check the running installation before recovery.')
        if self.changed:
            self.assert_selected()
            def restore():
                self.assert_configuration()
                self.archive('restore')
                self.configure(self.rollback_pin, restoring=True)
            recover_candidate(stop=lambda: self.docker('stop', '--time=-1', self.owned_id, timeout=None),
                restore=restore, start=lambda: self.start(self.old_image), verify=lambda: self.verify(self.old_revision), release=self.release)
            self.report('rolled_back', 'The update failed. The previous runtime and state were restored and verified.')
        elif self.configuration_changed:
            # A partial remote/local settings save has uncertain authority. Keep
            # the stopped/fenced installation and backup for deliberate recovery.
            raise UpdateError('Configuration changed partially. Check the private backup before recovery.')
        else:
            if self.drain_requested and not self.owns_drain:
                raise UpdateError('Maintenance ownership is uncertain. Keep the installation paused for review.')
            if self.owns_drain: self.assert_selected(); self.assert_configuration()
            if self.stopped: self.docker('start', self.old_id); self.verify(self.old_revision)
            if self.fenced: self.release()
            elif self.owns_drain: self.api('/api/maintenance/cancel', 'POST')
            self.report('failed', 'The update stopped before replacement. The previous installation remains available.')


def dry_run(version: str) -> None:
    if not re.fullmatch(r'\d+\.\d+\.\d+', version): raise UpdateError('Select an official Olympus release version.')
    target = load_release_target(version)
    # The regular constructor owns receipts/backups. Read-only inspection must
    # not call it or require request/status files from an accepted update.
    selected = DockerUpdate.__new__(DockerUpdate)
    selected.read_selection()
    selected.assert_selected()
    selected.assert_configuration()
    selected.assert_exclusive_volumes()
    configured_state = os.environ.get('OLYMPUS_HERMES_UPDATER_STATE_DIR')
    socket = os.environ.get('OLYMPUS_DISPATCH_UPDATE_SOCKET')
    if not configured_state and not socket: raise UpdateError('Configure the installation-local updater state directory or socket first.')
    state = Path(configured_state) if configured_state else Path(socket).parent / 'hermes-updater'
    if not state.is_absolute(): raise UpdateError('The updater state directory must be absolute.')
    print(json.dumps({'dryRun': True, 'mode': selected.mode, 'project': selected.project, 'service': selected.service,
        'hermesHome': selected.hermes_home, 'olympusHome': selected.olympus_home,
        'olympusVersion': version, 'hermesVersion': target['version'], 'hermesRevision': target['revision'],
        'backupDirectory': str(state / 'backup-<operation-id>')}))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--olympus-version', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    updater = None
    try:
        if args.dry_run:
            dry_run(args.olympus_version)
            return 0
        updater = DockerUpdate(args.olympus_version)
        updater.execute()
        return 0
    except Exception:
        if updater is not None:
            try: updater.recover()
            except Exception: updater.report('interrupted', 'Update recovery needs local attention. Work remains paused when the update fence is present; retain the private backup.')
        # Never forward Docker, Dokploy, environment or upstream error bodies.
        print('Hermes update did not complete. Check the safe Settings status and local recovery guide.', flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
