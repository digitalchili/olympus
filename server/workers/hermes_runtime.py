"""Read-only runtime identity; deliberately never imports the selected Hermes code."""
from __future__ import annotations

import ast
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

REVISION = re.compile(r'^[0-9a-f]{40}$')
IMAGE_PROVENANCE_PATH = Path('/etc/hermes/image-provenance.json')
VERSION = re.compile(r'^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$')


def _json(path: Path) -> dict[str, Any]:
    try:
        if path.stat().st_size > 65536:
            return {}
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _git(source: Path, *arguments: str) -> str | None:
    try:
        # Do not inherit caller-selected repositories, index files, or transport hooks.
        environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
        environment.update(GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0')
        result = subprocess.run(['git', '-C', str(source), *arguments], env=environment,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True, timeout=2, check=False)
        return result.stdout.strip() if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def get_runtime(source: Path | None) -> dict[str, Any]:
    result: dict[str, Any] = {'available': False, 'version': None, 'revision': None,
        'installation': 'unknown', 'sourcePath': None, 'pythonPath': sys.executable, 'dirty': None}
    if source is None or not (source / 'run_agent.py').is_file():
        return result
    result.update(available=True, sourcePath=str(source.resolve()))
    metadata: dict[str, str] = {}
    try:
        init = source / 'hermes_cli' / '__init__.py'
        if init.stat().st_size <= 65536:
            for node in ast.parse(init.read_text()).body:
                if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                    for target in node.targets:
                        if isinstance(target, ast.Name) and target.id in {'__version__', '__release_date__'}:
                            metadata[target.id] = node.value.value
    except (OSError, SyntaxError, ValueError):
        pass
    stamp = _json(source / 'install-stamp.json')
    version = metadata.get('__release_date__') or stamp.get('baseVersion') or metadata.get('__version__')
    if isinstance(version, str) and VERSION.fullmatch(version):
        result['version'] = version
    image_marker = IMAGE_PROVENANCE_PATH
    image = _json(image_marker)
    is_image = image_marker.exists() or os.environ.get('OLYMPUS_INSTALL_KIND') == 'docker'
    if is_image:
        result['installation'] = 'docker'
    elif stamp.get('source') == 'commit-build':
        result['installation'] = 'managed'
    elif (source / '.git').exists():
        result['installation'] = 'source'
    elif stamp:
        result['installation'] = 'managed'
    if result['version'] is None and isinstance(image.get('version'), str) and VERSION.fullmatch(image['version']):
        result['version'] = image['version']
    revision = _git(source, 'rev-parse', '--verify', 'HEAD') if (source / '.git').exists() else None
    revision = revision or image.get('revision') or stamp.get('commit') or stamp.get('revision')
    if isinstance(revision, str) and REVISION.fullmatch(revision):
        result['revision'] = revision
    if result['installation'] == 'source':
        status = _git(source, '-c', 'core.fsmonitor=false', 'status', '--porcelain', '--untracked-files=normal')
        result['dirty'] = bool(status) if status is not None else None
    return result
