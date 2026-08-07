"""Shared utilities for the Hermes worker and its submodules.

Kept intentionally small: just the error type and pure helpers that are used
across `hermes_worker.py`, `hermes_sessions.py`, and `hermes_scheduled_tasks.py`.
"""

from __future__ import annotations

import os
import re
from collections.abc import MutableMapping
from pathlib import Path
from typing import Any


OLYMPUS_WORKER_ENV_FILE = ".olympus-dispatch.env"
_WORKER_ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_PROTECTED_WORKER_ENV_PREFIXES = ("HERMES_", "OLYMPUS_")
_PROTECTED_WORKER_ENV_KEYS = {
    "BASH_ENV",
    "DB_PATH",
    "ENV",
    "HOME",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "NODE_OPTIONS",
    "PATH",
    "PYTHONHOME",
    "PYTHONPATH",
    "SHELL",
    "TERMINAL_ENV",
    "VIRTUAL_ENV",
}
_MAX_WORKER_ENV_BYTES = 64 * 1024


class WorkerError(Exception):
    def __init__(self, message: str, code: str = "worker_error", hint: str | None = None):
        super().__init__(message)
        self.code = code
        self.hint = hint


def _worker_environment_error(message: str) -> WorkerError:
    return WorkerError(
        message,
        code="invalid_worker_environment",
        hint=f"Fix or remove {OLYMPUS_WORKER_ENV_FILE} in this Hermes profile.",
    )


def _unquote_worker_environment_value(value: str, line_number: int) -> str:
    if not value or value[0] not in {"'", '"'}:
        return value
    quote = value[0]
    if len(value) < 2 or value[-1] != quote:
        raise _worker_environment_error(
            f"Invalid quoted value on line {line_number} of {OLYMPUS_WORKER_ENV_FILE}."
        )
    return value[1:-1]


def read_worker_environment_overrides(hermes_home: str | Path) -> dict[str, str]:
    """Read profile-local Olympus worker overrides without exposing values."""
    path = Path(hermes_home) / OLYMPUS_WORKER_ENV_FILE
    if path.is_symlink():
        raise _worker_environment_error(f"{OLYMPUS_WORKER_ENV_FILE} must not be a symbolic link.")
    try:
        stat = path.stat()
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise _worker_environment_error(f"Could not inspect {OLYMPUS_WORKER_ENV_FILE}: {type(exc).__name__}.") from exc
    if not path.is_file():
        raise _worker_environment_error(f"{OLYMPUS_WORKER_ENV_FILE} must be a regular file.")
    if stat.st_size > _MAX_WORKER_ENV_BYTES:
        raise _worker_environment_error(f"{OLYMPUS_WORKER_ENV_FILE} is too large.")

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise _worker_environment_error(f"Could not read {OLYMPUS_WORKER_ENV_FILE}: {type(exc).__name__}.") from exc

    overrides: dict[str, str] = {}
    for line_number, raw_line in enumerate(lines, 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise _worker_environment_error(
                f"Invalid entry on line {line_number} of {OLYMPUS_WORKER_ENV_FILE}."
            )
        key, raw_value = line.split("=", 1)
        key = key.strip()
        if not _WORKER_ENV_KEY.fullmatch(key):
            raise _worker_environment_error(
                f"Invalid variable name on line {line_number} of {OLYMPUS_WORKER_ENV_FILE}."
            )
        if key in _PROTECTED_WORKER_ENV_KEYS or key.startswith(_PROTECTED_WORKER_ENV_PREFIXES):
            raise _worker_environment_error(
                f"Protected variable {key} cannot be set in {OLYMPUS_WORKER_ENV_FILE}."
            )
        overrides[key] = _unquote_worker_environment_value(raw_value.strip(), line_number)
    return overrides


def apply_worker_environment_overrides(
    hermes_home: str | Path,
    environment: MutableMapping[str, str] | None = None,
) -> dict[str, str]:
    """Apply profile-local values after Hermes loads its native dotenv file."""
    target = os.environ if environment is None else environment
    overrides = read_worker_environment_overrides(hermes_home)
    target.update(overrides)
    return overrides


def string_or_none(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): json_safe(val) for key, val in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(item) for item in value]
    return str(value)


def truncate_with_ellipsis(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."
