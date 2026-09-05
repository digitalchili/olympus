"""Read-only inventory of Hermes-managed background work for one session.

This helper deliberately exposes only bounded identifiers, a coarse kind, and
status.  Commands, output previews, delegation goals, and result text stay in
Hermes' native registries.
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import closing
import sys
from pathlib import Path
from typing import Any

_ACTIVE_PROCESS_STATUSES = {"running"}
_ACTIVE_DELEGATION_STATUSES = {"running", "finalizing", "stalling"}
_ALLOWED_ID_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:@/-")


def _string_or_none(value: Any) -> str | None:
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return None


def _safe_identifier(value: Any, max_length: int = 160) -> str | None:
    value = _string_or_none(value)
    if not value or len(value) > max_length:
        return None
    return value if all(char in _ALLOWED_ID_CHARS for char in value) else None


def _normalize_status(value: Any) -> str | None:
    value = _string_or_none(value)
    if not value:
        return None
    status = value.lower()
    return status if _safe_identifier(status, 40) else None


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def _ensure_hermes_path() -> None:
    """Make native Hermes modules importable without loading user secrets."""
    candidates = [
        _string_or_none(os.environ.get("HERMES_AGENT_DIR")),
        str(Path.home() / ".hermes" / "hermes-agent"),
    ]
    for raw in candidates:
        if not raw:
            continue
        path = Path(raw).expanduser()
        try:
            if not (path / "run_agent.py").exists():
                continue
            resolved = str(path.resolve())
        except OSError:
            continue
        if resolved not in sys.path:
            sys.path.append(resolved)


def _native_process_registry() -> Any:
    _ensure_hermes_path()
    from tools.process_registry import process_registry  # type: ignore

    return process_registry


def _native_async_delegation() -> Any:
    _ensure_hermes_path()
    from tools import async_delegation  # type: ignore

    return async_delegation


def _request_session_ids(request: dict[str, Any]) -> list[str]:
    ids: list[str] = []
    for key in ("taskId", "task_id", "sessionId", "session_id"):
        safe = _safe_identifier(request.get(key))
        if safe:
            ids.append(safe)
    return _dedupe(ids)


def _lineage_aliases(session_id: str) -> list[str]:
    """Read task descendants, including compressed sessions and child agents.

    A completed child may have left a registered process alive. An unreadable
    existing ledger is not proof of no descendants: propagate to unavailable.
    """
    home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    db_path = home.expanduser().resolve() / "state.db"
    if not db_path.exists():
        return [session_id]
    with closing(sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True, timeout=1)) as db:
        # Native registries can create state.db before the first chat schema.
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").fetchone():
            return [session_id]
        rows = db.execute("""
            WITH RECURSIVE owned(id) AS (
                SELECT id FROM sessions WHERE id = ?
                UNION
                SELECT child.id FROM sessions child
                JOIN owned ON child.parent_session_id = owned.id
            ) SELECT id FROM owned LIMIT 257
        """, (session_id,)).fetchall()
    if len(rows) > 256:
        raise RuntimeError("session lineage exceeds bounded inventory")
    return _dedupe([session_id] + [str(row[0]) for row in rows if _safe_identifier(row[0])])


def _scoped_session_ids(request: dict[str, Any]) -> list[str]:
    scoped: list[str] = []
    for session_id in _request_session_ids(request):
        scoped.extend(_lineage_aliases(session_id))
    return _dedupe(scoped)


def _process_work(registry: Any, session_ids: list[str]) -> list[dict[str, str]]:
    list_sessions = getattr(registry, "list_sessions", None)
    if not callable(list_sessions):
        raise RuntimeError("process registry cannot list sessions")

    work: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for session_id in session_ids:
        sessions = list_sessions(task_id=session_id, session_key=session_id)
        if not isinstance(sessions, list):
            raise RuntimeError("process registry returned an unsupported shape")
        for entry in sessions:
            if not isinstance(entry, dict):
                continue
            status = _normalize_status(entry.get("status"))
            if status not in _ACTIVE_PROCESS_STATUSES:
                continue
            process_id = _safe_identifier(entry.get("session_id") or entry.get("id"))
            if not process_id:
                continue
            key = ("process", process_id)
            if key in seen:
                continue
            seen.add(key)
            work.append({"id": process_id, "kind": "process", "status": status})
    return work


def _snapshot_delegation_records(async_delegation: Any) -> list[dict[str, Any]]:
    records = getattr(async_delegation, "_records", None)
    lock = getattr(async_delegation, "_records_lock", None)
    if not isinstance(records, dict) or lock is None:
        raise RuntimeError("async delegation registry cannot be inspected")

    with lock:
        return [dict(record) for record in records.values() if isinstance(record, dict)]


def _delegation_work(async_delegation: Any, session_ids: list[str]) -> list[dict[str, str]]:
    owner_ids = set(session_ids)
    work: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()

    for record in _snapshot_delegation_records(async_delegation):
        status = _normalize_status(record.get("status") or record.get("state"))
        if status not in _ACTIVE_DELEGATION_STATUSES:
            continue
        record_owner_ids = {
            safe
            for safe in (
                _safe_identifier(record.get("session_key")),
                _safe_identifier(record.get("origin_session")),
                _safe_identifier(record.get("origin_session_id")),
                _safe_identifier(record.get("origin_ui_session_id")),
                _safe_identifier(record.get("parent_session_id")),
            )
            if safe
        }
        if not (record_owner_ids & owner_ids):
            continue
        delegation_id = _safe_identifier(record.get("delegation_id") or record.get("id"))
        if not delegation_id:
            continue
        key = ("delegation", delegation_id)
        if key in seen:
            continue
        seen.add(key)
        work.append({"id": delegation_id, "kind": "delegation", "status": status})
    return work


def get_background_work(
    request: dict[str, Any],
    *,
    process_registry: Any = None,
    async_delegation: Any = None,
) -> dict[str, Any]:
    """Return active Hermes-managed background work scoped to one task/session."""
    try:
        if not isinstance(request, dict):
            raise RuntimeError("request must be a dict")
        registry = process_registry if process_registry is not None else _native_process_registry()
        delegation_registry = async_delegation if async_delegation is not None else _native_async_delegation()
        session_ids = _scoped_session_ids(request)
        if not session_ids:
            raise RuntimeError("session id is required")

        work = _process_work(registry, session_ids)
        work.extend(_delegation_work(delegation_registry, session_ids))
        return {"available": True, "work": work[:100]}
    except Exception:
        return {"available": False, "work": []}
