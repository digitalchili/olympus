#!/usr/bin/env python3
"""Fixed restart command for one operator-selected Olympus LaunchAgent."""
from __future__ import annotations

import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import time
import uuid


def path_from_env(name: str) -> Path:
    value = os.environ.get(name, '')
    if not value or not Path(value).is_absolute():
        raise ValueError('The selected Olympus service requires absolute local paths.')
    return Path(value)


def restart() -> None:
    plist = path_from_env('OLYMPUS_HERMES_UPDATER_PLIST')
    expected = path_from_env('OLYMPUS_HERMES_EXPECTED_SOURCE').resolve()
    home = path_from_env('HERMES_HOME').resolve()
    state = path_from_env('OLYMPUS_DISPATCH_HOME').resolve()
    if plist.is_symlink() or plist.stat().st_mode & 0o022:
        raise ValueError('The selected LaunchAgent must be a protected regular file.')
    value = plistlib.loads(plist.read_bytes())
    environment = value.get('EnvironmentVariables', {})
    if Path(environment.get('HERMES_AGENT_DIR', '')).resolve() != expected or Path(environment.get('HERMES_HOME', '')).resolve() != home or Path(environment.get('OLYMPUS_DISPATCH_HOME', '')).resolve() != state:
        raise ValueError('The selected service no longer matches the approved installation.')
    label = value.get('Label')
    if not isinstance(label, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+', label):
        raise ValueError('The selected LaunchAgent label is invalid.')
    action = os.environ.get('OLYMPUS_HERMES_SERVICE_ACTION', 'restart')
    domain = 'gui/' + str(os.getuid())
    if action == 'stop':
        inspection = subprocess.run(['/bin/launchctl', 'print', domain + '/' + label], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        if inspection.returncode != 0:
            raise RuntimeError('The selected service stop state could not be confirmed.')
        match = re.search(r'^\s*pid = (\d+)\s*$', inspection.stdout, re.MULTILINE)
        if not match:
            raise RuntimeError('The selected service process could not be identified.')
        pid = int(match.group(1))
        subprocess.run(['/bin/launchctl', 'bootout', domain + '/' + label], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        for _ in range(60):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(1)
        raise RuntimeError('The selected service did not stop; state must not be restored.')
    if action != 'restart':
        raise ValueError('Invalid fixed service action.')
    source = path_from_env('OLYMPUS_HERMES_CANDIDATE_SOURCE').resolve()
    python = path_from_env('OLYMPUS_HERMES_CANDIDATE_PYTHON')
    if not (source / 'run_agent.py').is_file() or not os.access(python, os.X_OK):
        raise ValueError('The selected candidate runtime is unavailable.')
    environment['HERMES_AGENT_DIR'] = str(source)
    environment['HERMES_PYTHON'] = str(python)
    temporary = plist.with_name(plist.name + '.tmp-' + uuid.uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        plistlib.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(plist)
    domain = 'gui/' + str(os.getuid())
    subprocess.run(['/bin/launchctl', 'bootout', domain + '/' + label], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(10):
        result = subprocess.run(['/bin/launchctl', 'bootstrap', domain, str(plist)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode == 0:
            subprocess.run(['/bin/launchctl', 'kickstart', '-k', domain + '/' + label], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            return
        time.sleep(1)
    raise RuntimeError('The selected Olympus LaunchAgent did not restart.')


if __name__ == '__main__':
    try:
        if sys.platform != 'darwin': raise ValueError('This restart helper requires macOS.')
        restart()
    except Exception:
        print('The selected Olympus service could not restart.', file=sys.stderr)
        raise SystemExit(1)
