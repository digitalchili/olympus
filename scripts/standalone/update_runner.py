#!/usr/bin/env python3
"""Authenticated, Unix-socket-only Olympus update hook.

The web application sends a release payload over a host-mounted Unix socket. This
runner validates the payload and starts one fixed, root-controlled update command.
It never listens on TCP and never executes data from the request as shell code.
"""

from __future__ import annotations

import hmac
import json
import os
import re
import signal
import socketserver
import stat
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, cast

VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
MAX_BODY_BYTES = 16 * 1024


class UpdateServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def __init__(self, socket_path: str, token: str, repository: str, command: str):
        self.token = token
        self.repository = repository
        self.command = command
        self.process: subprocess.Popen[bytes] | None = None
        self.process_lock = threading.Lock()
        super().__init__(socket_path, UpdateHandler)

    def start_update(self, version: str) -> bool:
        with self.process_lock:
            if self.process is not None and self.process.poll() is None:
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


class UpdateHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        print(f"olympus-updater: {self.address_string()} - {format % args}", flush=True)

    def send_json(self, status_code: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_POST(self) -> None:  # noqa: N802 - stdlib HTTP handler API
        server = cast(UpdateServer, self.server)
        if self.path != "/update":
            self.send_json(404, {"error": "Not found."})
            return

        authorization = self.headers.get("Authorization", "")
        supplied = authorization[7:] if authorization.startswith("Bearer ") else ""
        if not hmac.compare_digest(supplied, server.token):
            self.send_json(401, {"error": "Valid update authentication is required."})
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


def main() -> int:
    try:
        socket_path = required_env("OLYMPUS_UPDATER_SOCKET")
        token = required_env("OLYMPUS_UPDATER_TOKEN")
        repository = required_env("OLYMPUS_UPDATER_REPOSITORY")
        command = validate_command(required_env("OLYMPUS_UPDATER_COMMAND"))
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
    try:
        socket_file.unlink(missing_ok=True)
        server = UpdateServer(socket_path, token, repository, command)
        os.chmod(socket_path, 0o660)
        if socket_gid >= 0:
            os.chown(socket_path, -1, socket_gid)
    except OSError as error:
        print(f"olympus-updater: could not create socket: {error}", file=sys.stderr)
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
