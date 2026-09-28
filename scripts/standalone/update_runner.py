#!/usr/bin/env python3
"""Authenticated, Unix-socket-only Olympus update hook.

The web application sends a release payload over a host-mounted Unix socket. This
runner validates the payload and starts one fixed, root-controlled update command.
It never listens on TCP and never executes data from the request as shell code.
"""

from __future__ import annotations

import hmac
import fcntl
import shutil
from datetime import datetime
import json
import os
import re
import signal
import socketserver
import stat
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, cast

VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
STABLE_VERSION_RE = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')
MAX_BODY_BYTES = 16 * 1024
TERMINAL_PHASES = {'completed', 'failed', 'rolled_back', 'interrupted'}
PHASES = TERMINAL_PHASES | {'preparing', 'draining', 'backing_up', 'installing', 'verifying'}


def validate_target(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or type(value.get('schemaVersion')) is not int or value.get('schemaVersion') != 1:
        raise ValueError('Invalid Hermes compatibility target.')
    version = value.get('version')
    if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
        raise ValueError('Invalid Hermes compatibility version.')
    if not isinstance(value.get('revision'), str) or not re.fullmatch(r'[0-9a-f]{40}', value['revision']):
        raise ValueError('Invalid Hermes compatibility revision.')
    if not isinstance(value.get('image'), str) or not re.fullmatch(r'nousresearch/hermes-agent:v' + re.escape(version) + r'@sha256:[0-9a-f]{64}', value['image']):
        raise ValueError('Invalid Hermes compatibility image.')
    if value.get('releaseUrl') != f'https://github.com/NousResearch/hermes-agent/releases/tag/v{version}':
        raise ValueError('Invalid Hermes release URL.')
    return {key: value[key] for key in ('schemaVersion', 'version', 'revision', 'image', 'releaseUrl')}


def load_release_target(version: str) -> dict[str, Any]:
    if not STABLE_VERSION_RE.fullmatch(version):
        raise ValueError('A stable published Olympus release is required.')
    request = urllib.request.Request(f'https://api.github.com/repos/digitalchili/olympus/releases/tags/v{version}', headers={'User-Agent': 'olympus-updater', 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request, timeout=20) as response:
        release_data = response.read(MAX_BODY_BYTES + 1)
    if len(release_data) > MAX_BODY_BYTES:
        raise ValueError('Invalid Olympus release information.')
    release = json.loads(release_data)
    if not isinstance(release, dict) or release.get('tag_name') != 'v' + version or release.get('draft') is not False or release.get('prerelease') is not False or not isinstance(release.get('published_at'), str):
        raise ValueError('A stable published Olympus release is required.')
    try:
        datetime.fromisoformat(release['published_at'].replace('Z', '+00:00'))
    except ValueError:
        raise ValueError('A stable published Olympus release is required.') from None
    url = f'https://raw.githubusercontent.com/digitalchili/olympus/v{version}/hermes-runtime.json'
    request = urllib.request.Request(url, headers={'User-Agent': 'olympus-updater'})
    with urllib.request.urlopen(request, timeout=20) as response:
        data = response.read(MAX_BODY_BYTES + 1)
    if len(data) > MAX_BODY_BYTES:
        raise ValueError('Invalid Hermes compatibility manifest.')
    return validate_target(json.loads(data))


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(value, stream, separators=(',', ':'))
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)



class UpdateServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def __init__(self, socket_path: str, token: str, repository: str, command: str, *, hermes_command: str | None = None, hermes_mode: str = "unavailable", state_directory: str | None = None):
        self.token = token
        self.repository = repository
        self.command = command
        self.process: subprocess.Popen[bytes] | None = None
        self.process_lock = threading.Lock()
        self.hermes_command = hermes_command
        self.hermes_mode = hermes_mode
        self.state_directory = Path(state_directory or str(Path(socket_path).parent / 'hermes-updater'))
        self.status_path = self.state_directory / 'operation.json'
        self.request_path = self.state_directory / 'request.json'
        self.hermes_process: subprocess.Popen[bytes] | None = None
        super().__init__(socket_path, UpdateHandler)

    def start_update(self, version: str) -> bool:
        with self.process_lock:
            if self._busy():
                return False
            env = os.environ.copy()
            env["OLYMPUS_UPDATE_VERSION"] = version
            env["OLYMPUS_UPDATE_REPOSITORY"] = self.repository
            self.process = subprocess.Popen(
                [self.command, "--version", version],
                env=env,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
            return True

    def _read_operation(self) -> dict[str, Any] | None:
        try:
            if self.status_path.stat().st_size > MAX_BODY_BYTES:
                raise ValueError('Invalid operation receipt.')
            operation = json.loads(self.status_path.read_text())
            if not isinstance(operation, dict) or operation.get('phase') not in PHASES:
                raise ValueError('Invalid operation receipt.')
            # Only the fixed helper's safe status schema crosses the socket.
            return {key: operation[key] for key in ('id', 'phase', 'targetRevision', 'targetVersion', 'startedAt', 'updatedAt', 'message')}
        except FileNotFoundError:
            return None
        except (OSError, ValueError, KeyError):
            return {'id': 'unknown', 'phase': 'interrupted', 'targetRevision': '', 'targetVersion': '',
                    'startedAt': 0, 'updatedAt': 0, 'message': 'Update status needs local recovery before another update.'}

    def _reconcile(self) -> dict[str, Any] | None:
        operation = self._read_operation()
        if operation and operation['phase'] not in TERMINAL_PHASES:
            exit_code = self.hermes_process.poll() if self.hermes_process is not None else None
            if self.hermes_process is None or exit_code is not None:
                operation.update(phase='interrupted' if self.hermes_process is None else 'failed',
                                 updatedAt=int(time.time() * 1000),
                                 message='Update was interrupted; check local recovery.' if self.hermes_process is None else 'The update helper did not confirm completion.')
                atomic_json(self.status_path, operation)
        return operation

    def _busy(self) -> bool:
        operation = self._reconcile()
        return bool((self.process is not None and self.process.poll() is None)
                    or (self.hermes_process is not None and self.hermes_process.poll() is None)
                    or (operation and operation['phase'] == 'interrupted'))

    def hermes_status(self) -> dict[str, Any]:
        with self.process_lock:
            operation = self._reconcile()
            return {'method': self.hermes_mode,
                    'configured': bool(self.hermes_command and not (operation and operation['phase'] == 'interrupted')),
                    'operation': operation}

    def start_hermes_update(self, payload: dict[str, Any]) -> bool:
        version = payload.get('olympusVersion')
        if self.repository != 'digitalchili/olympus' or payload.get('repository') != self.repository:
            raise ValueError('Unexpected update repository.')
        if not isinstance(version, str) or not STABLE_VERSION_RE.fullmatch(version):
            raise ValueError('Invalid Olympus release version.')
        target = validate_target(payload.get('target'))
        with self.process_lock:
            if self._busy():
                return False
            if not self.hermes_command or self.hermes_mode not in {'native', 'docker', 'dokploy'}:
                raise ValueError('Hermes update helper is not configured.')
            if target != load_release_target(version):
                raise ValueError('The Hermes target does not match the approved Olympus release.')
            now = int(time.time() * 1000)
            operation = {'id': str(uuid.uuid4()), 'phase': 'preparing', 'targetRevision': target['revision'],
                         'targetVersion': target['version'], 'startedAt': now, 'updatedAt': now,
                         'message': 'Preparing the approved Hermes update.'}
            atomic_json(self.request_path, {'repository': self.repository, 'olympusVersion': version, 'target': target})
            atomic_json(self.status_path, operation)
            environment = os.environ.copy()
            environment['OLYMPUS_HERMES_UPDATE_REQUEST_FILE'] = str(self.request_path.resolve())
            environment['OLYMPUS_HERMES_UPDATE_STATUS_FILE'] = str(self.status_path.resolve())
            try:
                self.hermes_process = subprocess.Popen([self.hermes_command, '--olympus-version', version],
                    env=environment, stdin=subprocess.DEVNULL, start_new_session=True)
                self.process = self.hermes_process
            except OSError:
                operation.update(phase='failed', message='The local update helper could not start.')
                atomic_json(self.status_path, operation)
                raise
            return True


class UpdateHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        # Unix-domain clients have no host/port address; BaseHTTPRequestHandler's
        # address_string() assumes an INET tuple and crashes before a response.
        print(f"olympus-updater: {format % args}", flush=True)

    def send_json(self, status_code: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def authenticated(self) -> bool:
        server = cast(UpdateServer, self.server)
        authorization = self.headers.get("Authorization", "")
        supplied = authorization[7:] if authorization.startswith("Bearer ") else ""
        if not hmac.compare_digest(supplied, server.token):
            self.send_json(401, {"error": "Valid update authentication is required."})
            return False
        return True

    def do_GET(self) -> None:
        if self.path != '/hermes':
            self.send_json(404, {'error': 'Not found.'})
        elif self.authenticated():
            self.send_json(200, cast(UpdateServer, self.server).hermes_status())

    def do_POST(self) -> None:  # noqa: N802 - stdlib HTTP handler API
        server = cast(UpdateServer, self.server)
        if self.path not in {"/update", "/hermes"}:
            self.send_json(404, {"error": "Not found."})
            return

        if not self.authenticated():
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            self.send_json(400, {"error": "Invalid update payload size."})
            return

        try:
            payload = json.loads(self.rfile.read(content_length))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {"error": "Invalid update payload."})
            return

        if self.path == '/hermes':
            try:
                started = server.start_hermes_update(payload if isinstance(payload, dict) else {})
            except ValueError as error:
                self.send_json(400, {'error': str(error)})
                return
            except Exception:
                self.send_json(503, {'error': 'The approved Hermes update could not be prepared.'})
                return
            if not started:
                self.send_json(409, {'error': 'An update is already running or needs recovery.'})
            else:
                operation = server.hermes_status()['operation']
                self.send_json(202, {'accepted': True, 'operationId': operation['id']})
            return

        repository = payload.get("repository") if isinstance(payload, dict) else None
        version = payload.get("latestVersion") if isinstance(payload, dict) else None
        if repository != server.repository:
            self.send_json(400, {"error": "Unexpected update repository."})
            return
        if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
            self.send_json(400, {"error": "Invalid update version."})
            return

        try:
            started = server.start_update(version)
        except OSError as error:
            print(f"olympus-updater: failed to start update command: {error}", file=sys.stderr, flush=True)
            self.send_json(500, {"error": "The local update command could not start."})
            return
        if not started:
            self.send_json(409, {"error": "An update is already running."})
            return
        self.send_json(202, {"accepted": True})


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required")
    return value


def validate_command(value: str) -> str:
    path = Path(value)
    if not path.is_absolute() or not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError("OLYMPUS_UPDATER_COMMAND must be an absolute executable file")
    mode = path.stat().st_mode
    if mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise ValueError("OLYMPUS_UPDATER_COMMAND must not be group/world writable")
    return str(path)


def validate_hermes_configuration(mode: str) -> None:
    if mode == 'unavailable': return
    if os.environ.get('OLYMPUS_HERMES_UPDATER_EXCLUSIVE') != '1':
        raise ValueError('Hermes updates require explicit dedicated installation ownership.')
    paths = ['HERMES_AGENT_DIR', 'HERMES_PYTHON', 'HERMES_HOME', 'OLYMPUS_DISPATCH_HOME'] if mode == 'native' else ['OLYMPUS_UPDATER_COMPOSE_DIR']
    for name in paths:
        path = Path(required_env(name))
        if not path.is_absolute() or not path.exists(): raise ValueError(f'{name} must select an existing absolute local path.')
    if mode == 'native':
        required_env('OLYMPUS_MAINTENANCE_TOKEN')
        validate_command(required_env('OLYMPUS_HERMES_UPDATER_RESTART_COMMAND'))
        validate_command(os.environ.get('OLYMPUS_HERMES_UPDATER_UV') or shutil.which('uv') or '')
        plist = os.environ.get('OLYMPUS_HERMES_UPDATER_PLIST')
        if plist and (not Path(plist).is_absolute() or not Path(plist).is_file()):
            raise ValueError('The selected native LaunchAgent is unavailable.')
    else:
        required_env('OLYMPUS_UPDATER_COMPOSE_PROJECT')
        if mode == 'dokploy':
            required_env('OLYMPUS_DOKPLOY_URL')
            required_env('OLYMPUS_DOKPLOY_COMPOSE_ID')
            key = Path(required_env('OLYMPUS_DOKPLOY_API_KEY_FILE'))
            if not key.is_absolute() or not key.is_file() or key.stat().st_mode & 0o077:
                raise ValueError('The installation-local Dokploy key file must be private.')


def main() -> int:
    try:
        socket_path = required_env("OLYMPUS_UPDATER_SOCKET")
        token = required_env("OLYMPUS_UPDATER_TOKEN")
        repository = required_env("OLYMPUS_UPDATER_REPOSITORY")
        command = validate_command(required_env("OLYMPUS_UPDATER_COMMAND"))
        hermes_command_value = os.environ.get('OLYMPUS_HERMES_UPDATER_COMMAND', '').strip()
        hermes_command = validate_command(hermes_command_value) if hermes_command_value else None
        hermes_mode = os.environ.get('OLYMPUS_HERMES_UPDATER_MODE', 'unavailable')
        if hermes_mode not in {'native', 'docker', 'dokploy', 'unavailable'}:
            raise ValueError('Invalid Hermes updater mode.')
        if bool(hermes_command) != (hermes_mode != 'unavailable'):
            raise ValueError('Hermes updater command and mode must both be configured.')
        validate_hermes_configuration(hermes_mode)
        socket_gid_text = os.environ.get("OLYMPUS_UPDATER_SOCKET_GID", "").strip()
        socket_gid = int(socket_gid_text) if socket_gid_text else -1
    except (ValueError, OSError) as error:
        print(f"olympus-updater: configuration error: {error}", file=sys.stderr)
        return 2

    if len(token) < 32:
        print("olympus-updater: OLYMPUS_UPDATER_TOKEN must contain at least 32 characters", file=sys.stderr)
        return 2

    socket_file = Path(socket_path)
    socket_file.parent.mkdir(parents=True, exist_ok=True)
    lock_file = socket_file.with_name(socket_file.name + '.lock')
    lock_descriptor = os.open(lock_file, os.O_WRONLY | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lock_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        socket_file.unlink(missing_ok=True)
        server = UpdateServer(socket_path, token, repository, command, hermes_command=hermes_command, hermes_mode=hermes_mode, state_directory=os.environ.get('OLYMPUS_HERMES_UPDATER_STATE_DIR'))
        os.chmod(socket_path, 0o660)
        if socket_gid >= 0:
            os.chown(socket_path, -1, socket_gid)
    except OSError as error:
        print(f"olympus-updater: could not create socket: {error}", file=sys.stderr)
        os.close(lock_descriptor)
        return 2

    def stop(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"olympus-updater: listening on Unix socket {socket_path}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        socket_file.unlink(missing_ok=True)
        os.close(lock_descriptor)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
