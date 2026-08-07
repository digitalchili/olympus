"""Project Hermes SessionDB rows into the shape Minions consumes.

Owns transcript sanitization for replay-as-conversation, message projection
for the chat UI, and session metadata projection for cost/token displays.
"""

from __future__ import annotations

import base64
import json
import sqlite3
import time
from typing import Any

from hermes_worker_utils import WorkerError, json_safe, string_or_none


AGENT_HISTORY_KEYS = {
    "role",
    "content",
    "tool_calls",
    "tool_call_id",
    "tool_name",
    "finish_reason",
    "reasoning",
    "reasoning_content",
    "reasoning_details",
    "codex_reasoning_items",
    "codex_message_items",
}


def _sanitize_agent_history(history: Any) -> list[dict[str, Any]]:
    if not isinstance(history, list):
        return []
    safe: list[dict[str, Any]] = []
    for item in history:
        if not isinstance(item, dict):
            continue
        if item.get("display_kind") == "olympus_steer":
            # This trusted display-only row makes an applied steer visible in
            # Olympus. Hermes already receives the same text in the tool-result
            # marker, so replaying the row would duplicate the instruction.
            continue
        role = item.get("role")
        if role not in {"user", "assistant", "system", "tool"}:
            continue

        safe_item = {
            key: json_safe(value)
            for key, value in item.items()
            if key in AGENT_HISTORY_KEYS and value is not None
        }
        if not safe_item.get("content") and not safe_item.get("tool_calls") and not safe_item.get("tool_call_id"):
            continue
        safe_item["role"] = role
        safe.append(safe_item)
    return safe


COMPACTION_REFERENCE_PREFIX = "[CONTEXT COMPACTION"
COMPACTION_MARKER_TEXT = "Context compacted. Earlier conversation was summarized so the agent could continue."
ASYNC_DELEGATION_CALLBACK_PREFIX = "[ASYNC DELEGATION "


def open_session(session_id: str, *, resolve_live: bool = True) -> tuple[Any, str]:
    """Return (session_db, resolved_session_id) for the given session.

    Resolves Hermes compression aliases so chat runs continue from the live
    session tip instead of replaying an old root session.
    """
    # Lazy import so this module has no top-level dependency on hermes_worker.
    # `hermes_worker` aliases itself into sys.modules at startup (see top of
    # `hermes_worker.py`), so this returns the same module instance even when
    # the worker is invoked as a script.
    import hermes_worker

    hermes_worker._ensure_imports()
    if hermes_worker._SessionDB is None:
        raise WorkerError(
            "Hermes session database is unavailable.",
            code="session_db_unavailable",
        )
    db = hermes_worker._SessionDB()
    if not resolve_live:
        return db, session_id
    return db, _resolve_live_session_id(db, session_id)


def _resolve_live_session_id(session_db: Any, session_id: str) -> str:
    compression_tip = getattr(session_db, "get_compression_tip", None)
    if callable(compression_tip):
        try:
            return compression_tip(session_id) or session_id
        except Exception:
            pass

    resolve = getattr(session_db, "resolve_resume_session_id", None)
    if callable(resolve):
        try:
            return resolve(session_id) or session_id
        except Exception:
            return session_id
    return session_id


def _session_lineage_ids(session_db: Any, root_session_id: str) -> list[str]:
    """Return root plus compression child sessions in chronological order."""
    session_ids = [root_session_id]
    db_path = getattr(session_db, "db_path", None)
    if db_path:
        try:
            with sqlite3.connect(str(db_path)) as conn:
                rows = conn.execute(
                    """
                    WITH RECURSIVE lineage(id, started_at, depth) AS (
                      SELECT id, started_at, 0
                      FROM sessions
                      WHERE id = ?
                      UNION ALL
                      SELECT child.id, child.started_at, lineage.depth + 1
                      FROM sessions child
                      JOIN lineage ON child.parent_session_id = lineage.id
                      JOIN sessions parent ON parent.id = lineage.id
                      WHERE lineage.depth < 100
                        AND parent.end_reason = 'compression'
                    )
                    SELECT id
                    FROM lineage
                    ORDER BY started_at, id
                    """,
                    (root_session_id,),
                ).fetchall()
            queried_ids = [str(row[0]) for row in rows if row and row[0]]
            if queried_ids:
                session_ids = queried_ids
        except Exception:
            pass

    # Fallback: if CTE failed or db_path unavailable, resolve via Hermes API
    if len(session_ids) == 1:
        live_session_id = _resolve_live_session_id(session_db, root_session_id)
        if live_session_id != root_session_id:
            session_ids.append(live_session_id)
    return session_ids


def load_agent_history(session_db: Any, session_id: str) -> list[dict[str, Any]]:
    if not session_id:
        return []
    try:
        get_session = getattr(session_db, "get_session", None)
        if callable(get_session) and not get_session(session_id):
            return []
        history = session_db.get_messages_as_conversation(session_id)
    except Exception as exc:
        raise WorkerError(f"Could not load Hermes session history: {exc}", code="session_load_error") from exc
    return _sanitize_agent_history(history)


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if content is None:
        return ""
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                if item:
                    parts.append(item)
                continue
            if isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if isinstance(text, str) and text:
                    parts.append(text)
                    continue
                item_type = string_or_none(item.get("type"))
                if item_type:
                    parts.append(f"[{item_type}]")
        return "\n".join(parts) if parts else "[non-text content]"
    if isinstance(content, dict):
        text = content.get("text") or content.get("content")
        if isinstance(text, str):
            return text
        return "[non-text content]"
    return str(content)


def _strip_minions_user_scaffold(content: str) -> str:
    stripped = content.lstrip()
    if stripped.startswith("[TASK AGENT]"):
        marker = "[TASK DESCRIPTION]"
        marker_index = stripped.find(marker)
        if marker_index >= 0:
            return stripped[marker_index + len(marker):].lstrip("\r\n ")

    if stripped.startswith("<task_agent>"):
        marker = "</task_agent>"
        marker_index = stripped.find(marker)
        if marker_index >= 0:
            remainder = stripped[marker_index + len(marker):].lstrip()
            if remainder.startswith("<task_description>"):
                end_marker = "</task_description>"
                end_index = remainder.find(end_marker)
                if end_index >= 0:
                    return remainder[len("<task_description>"):end_index].strip()
            return remainder

    return content


def _is_compaction_reference(content: str) -> bool:
    stripped = content.lstrip()
    return (
        stripped.startswith(COMPACTION_REFERENCE_PREFIX)
        and "REFERENCE ONLY" in stripped[:200]
    )


def _is_async_delegation_callback(content: str) -> bool:
    return content.lstrip().startswith(ASYNC_DELEGATION_CALLBACK_PREFIX)


def _timestamp_to_ms(timestamp: Any) -> int:
    try:
        value = float(timestamp)
    except (TypeError, ValueError):
        return int(time.time() * 1000)
    if value < 10_000_000_000:
        value *= 1000
    return int(value)


def _thinking_to_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value or None
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)


def project_session_messages(session_id: Any, task_id: Any = None) -> dict[str, Any]:
    session_id = string_or_none(session_id)
    if not session_id:
        raise WorkerError("Session ID is required.", code="bad_request")

    session_db, root_session_id = open_session(session_id, resolve_live=False)
    projected: list[dict[str, Any]] = []
    projected_task_id = string_or_none(task_id) or session_id

    for lineage_index, lineage_session_id in enumerate(_session_lineage_ids(session_db, root_session_id)):
        try:
            rows = session_db.get_messages(lineage_session_id)
        except Exception as exc:
            raise WorkerError(f"Could not load Hermes session messages: {exc}", code="session_load_error") from exc

        is_root_session = lineage_index == 0
        compaction_seen = is_root_session
        child_user_seen = is_root_session

        for row in rows:
            if not isinstance(row, dict):
                row = dict(row)
            role = row.get("role")
            if role not in {"user", "assistant"}:
                continue

            content = _content_to_text(row.get("content"))
            if role == "user":
                content = _strip_minions_user_scaffold(content)
                if _is_compaction_reference(content):
                    projected.append({
                        "id": f"hermes:{lineage_session_id}:compaction:{row.get('id')}",
                        "task_id": projected_task_id,
                        "role": "system",
                        "content": COMPACTION_MARKER_TEXT,
                        "created_at": _timestamp_to_ms(row.get("timestamp")),
                    })
                    compaction_seen = True
                    child_user_seen = False
                    continue
                if _is_async_delegation_callback(content):
                    if compaction_seen:
                        child_user_seen = True
                    continue
                if not compaction_seen:
                    continue
                child_user_seen = True
            elif not compaction_seen or not child_user_seen:
                continue

            if role == "assistant" and not content.strip() and row.get("tool_calls"):
                continue
            if not content.strip():
                continue

            message = {
                "id": f"hermes:{lineage_session_id}:{row.get('id')}",
                "task_id": projected_task_id,
                "role": role,
                "content": content,
                "created_at": _timestamp_to_ms(row.get("timestamp")),
            }
            if role == "assistant":
                thinking = (
                    _thinking_to_text(row.get("reasoning_content"))
                    or _thinking_to_text(row.get("reasoning"))
                    or _thinking_to_text(row.get("reasoning_details"))
                    or _thinking_to_text(row.get("codex_reasoning_items"))
                )
                if thinking:
                    message["thinking"] = thinking
            projected.append(message)

    return {"messages": projected}


MESSAGE_PAGE_DEFAULT_LIMIT = 40
MESSAGE_PAGE_MAX_LIMIT = 100
MESSAGE_PAGE_MAX_RAW_SCAN = 800
MESSAGE_PAGE_PREFIX_SCAN = 200


def _encode_message_cursor(lineage_index: int, before_offset: int) -> str:
    payload = json.dumps([lineage_index, before_offset], separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_message_cursor(value: Any) -> tuple[int, int] | None:
    cursor = string_or_none(value)
    if not cursor:
        return None
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        if (
            not isinstance(decoded, list)
            or len(decoded) != 2
            or isinstance(decoded[0], bool)
            or isinstance(decoded[1], bool)
        ):
            raise ValueError
        if not isinstance(decoded[0], int) or not isinstance(decoded[1], int):
            raise ValueError
        lineage_index = decoded[0]
        before_offset = decoded[1]
        if lineage_index < 0 or before_offset < 0:
            raise ValueError
        return lineage_index, before_offset
    except Exception as exc:
        raise WorkerError("Invalid message cursor.", code="bad_request") from exc


def _message_page_limit(value: Any) -> int:
    if value is None:
        return MESSAGE_PAGE_DEFAULT_LIMIT
    if isinstance(value, bool):
        raise WorkerError("Message page limit must be an integer.", code="bad_request")
    if isinstance(value, int):
        limit = value
    elif isinstance(value, str) and value.isdigit():
        limit = int(value)
    else:
        raise WorkerError("Message page limit must be an integer.", code="bad_request")
    if limit < 1 or limit > MESSAGE_PAGE_MAX_LIMIT:
        raise WorkerError(
            f"Message page limit must be between 1 and {MESSAGE_PAGE_MAX_LIMIT}.",
            code="bad_request",
        )
    return limit


def _active_message_counts(session_db: Any, session_ids: list[str]) -> dict[str, int]:
    if not session_ids:
        return {}
    db_path = getattr(session_db, "db_path", None)
    if not db_path:
        raise WorkerError("Hermes session database path is unavailable.", code="session_db_unavailable")
    placeholders = ",".join("?" for _ in session_ids)
    try:
        with sqlite3.connect(str(db_path)) as conn:
            rows = conn.execute(
                f"SELECT session_id, COUNT(*) FROM messages "
                f"WHERE active = 1 AND session_id IN ({placeholders}) GROUP BY session_id",
                session_ids,
            ).fetchall()
    except Exception as exc:
        raise WorkerError(f"Could not count Hermes session messages: {exc}", code="session_load_error") from exc
    counts = {session_id: 0 for session_id in session_ids}
    counts.update({str(row[0]): int(row[1]) for row in rows})
    return counts


def _child_projection_boundary(session_db: Any, session_id: str, count: int) -> tuple[int | None, int | None]:
    """Find the compaction marker and first visible user without loading the thread."""
    prefix_limit = min(count, MESSAGE_PAGE_PREFIX_SCAN)
    if prefix_limit <= 0:
        return None, None
    try:
        rows = session_db.get_messages(session_id, limit=prefix_limit, offset=0)
    except Exception as exc:
        raise WorkerError(f"Could not load Hermes session messages: {exc}", code="session_load_error") from exc

    marker_id: int | None = None
    first_user_id: int | None = None
    for row in rows:
        if not isinstance(row, dict):
            row = dict(row)
        if row.get("role") != "user":
            continue
        content = _strip_minions_user_scaffold(_content_to_text(row.get("content")))
        row_id = int(row.get("id") or 0)
        if marker_id is None:
            if _is_compaction_reference(content):
                marker_id = row_id
            continue
        if not _is_compaction_reference(content):
            first_user_id = row_id
            break
    return marker_id, first_user_id


def _project_message_page_row(
    row: Any,
    lineage_session_id: str,
    projected_task_id: str,
    child_boundary: tuple[int | None, int | None] | None,
) -> dict[str, Any] | None:
    if not isinstance(row, dict):
        row = dict(row)
    role = row.get("role")
    if role not in {"user", "assistant"}:
        return None

    row_id = int(row.get("id") or 0)
    content = _content_to_text(row.get("content"))
    if role == "user":
        content = _strip_minions_user_scaffold(content)
        if _is_compaction_reference(content):
            return {
                "id": f"hermes:{lineage_session_id}:compaction:{row.get('id')}",
                "task_id": projected_task_id,
                "role": "system",
                "content": COMPACTION_MARKER_TEXT,
                "created_at": _timestamp_to_ms(row.get("timestamp")),
            }
        if _is_async_delegation_callback(content):
            return None

    if child_boundary is not None:
        marker_id, first_user_id = child_boundary
        if marker_id is None or first_user_id is None or row_id < first_user_id:
            return None

    if role == "assistant" and not content.strip() and row.get("tool_calls"):
        return None
    if not content.strip():
        return None

    message = {
        "id": f"hermes:{lineage_session_id}:{row.get('id')}",
        "task_id": projected_task_id,
        "role": role,
        "content": content,
        "created_at": _timestamp_to_ms(row.get("timestamp")),
    }
    if role == "assistant":
        thinking = (
            _thinking_to_text(row.get("reasoning_content"))
            or _thinking_to_text(row.get("reasoning"))
            or _thinking_to_text(row.get("reasoning_details"))
            or _thinking_to_text(row.get("codex_reasoning_items"))
        )
        if thinking:
            message["thinking"] = thinking
    return message


def project_session_message_page(
    session_id: Any,
    task_id: Any = None,
    limit: Any = None,
    before: Any = None,
) -> dict[str, Any]:
    """Project a bounded tail-first page while keeping Hermes SessionDB canonical."""
    session_id = string_or_none(session_id)
    if not session_id:
        raise WorkerError("Session ID is required.", code="bad_request")
    page_limit = _message_page_limit(limit)
    session_db, root_session_id = open_session(session_id, resolve_live=False)
    lineage_ids = _session_lineage_ids(session_db, root_session_id)
    counts = _active_message_counts(session_db, lineage_ids)
    projected_task_id = string_or_none(task_id) or session_id

    decoded_cursor = _decode_message_cursor(before)
    if decoded_cursor is None:
        lineage_index = len(lineage_ids) - 1
        before_offset = counts.get(lineage_ids[lineage_index], 0) if lineage_ids else 0
    else:
        lineage_index, before_offset = decoded_cursor
        if lineage_index >= len(lineage_ids):
            raise WorkerError("Invalid message cursor.", code="bad_request")
        before_offset = min(before_offset, counts.get(lineage_ids[lineage_index], 0))

    max_raw_scan = max(200, min(MESSAGE_PAGE_MAX_RAW_SCAN, page_limit * 8))
    projected_desc: list[dict[str, Any]] = []
    inspected = 0
    boundaries: dict[str, tuple[int | None, int | None]] = {}

    while lineage_index >= 0 and inspected < max_raw_scan:
        lineage_session_id = lineage_ids[lineage_index]
        if before_offset <= 0:
            lineage_index -= 1
            if lineage_index >= 0:
                before_offset = counts.get(lineage_ids[lineage_index], 0)
            continue

        take = min(before_offset, max_raw_scan - inspected)
        start_offset = before_offset - take
        try:
            rows = session_db.get_messages(
                lineage_session_id,
                limit=take,
                offset=start_offset,
            )
        except Exception as exc:
            raise WorkerError(f"Could not load Hermes session messages: {exc}", code="session_load_error") from exc

        child_boundary = None
        if lineage_index > 0:
            child_boundary = boundaries.get(lineage_session_id)
            if child_boundary is None:
                child_boundary = _child_projection_boundary(
                    session_db,
                    lineage_session_id,
                    counts.get(lineage_session_id, 0),
                )
                boundaries[lineage_session_id] = child_boundary

        for row_index in range(len(rows) - 1, -1, -1):
            inspected += 1
            before_offset = start_offset + row_index
            message = _project_message_page_row(
                rows[row_index],
                lineage_session_id,
                projected_task_id,
                child_boundary,
            )
            if message is not None:
                projected_desc.append(message)
            if len(projected_desc) >= page_limit:
                has_older = before_offset > 0 or lineage_index > 0
                return {
                    "messages": list(reversed(projected_desc)),
                    "pageInfo": {
                        "hasOlder": has_older,
                        "olderCursor": _encode_message_cursor(lineage_index, before_offset) if has_older else None,
                    },
                }

        before_offset = start_offset

    has_older = before_offset > 0 or lineage_index > 0
    return {
        "messages": list(reversed(projected_desc)),
        "pageInfo": {
            "hasOlder": has_older,
            "olderCursor": _encode_message_cursor(lineage_index, before_offset) if has_older else None,
        },
    }


def _int_field(row: dict[str, Any], key: str) -> int:
    try:
        return int(row.get(key) or 0)
    except Exception:
        return 0


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except Exception:
        return None


def project_session_metadata(session_id: Any) -> dict[str, Any]:
    session_id = string_or_none(session_id)
    if not session_id:
        raise WorkerError("Session ID is required.", code="bad_request")

    session_db, live_session_id = open_session(session_id)
    try:
        row = session_db.get_session(live_session_id)
    except Exception as exc:
        raise WorkerError(f"Could not load Hermes session metadata: {exc}", code="session_load_error") from exc

    if not row:
        return {"session": None}

    return {
        "session": {
            "id": str(row.get("id") or live_session_id),
            "input_tokens": _int_field(row, "input_tokens"),
            "output_tokens": _int_field(row, "output_tokens"),
            "cache_read_tokens": _int_field(row, "cache_read_tokens"),
            "cache_write_tokens": _int_field(row, "cache_write_tokens"),
            "reasoning_tokens": _int_field(row, "reasoning_tokens"),
            "estimated_cost_usd": _float_or_none(row.get("estimated_cost_usd")),
            "cost_status": string_or_none(row.get("cost_status")) or "unknown",
            "model": string_or_none(row.get("model")),
        }
    }
