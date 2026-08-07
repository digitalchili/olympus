#!/usr/bin/env python3
"""Regression tests for bounded tail-first Hermes transcript projection."""

from __future__ import annotations

import contextlib
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server" / "workers"))

import hermes_sessions
import hermes_worker
from hermes_worker_utils import WorkerError


class FixtureSessionDB:
    def __init__(self, db_path: Path):
        self.db_path = db_path

    def get_messages(self, session_id: str, include_inactive: bool = False, limit: int | None = None, offset: int = 0):
        active_clause = "" if include_inactive else "AND active = 1"
        limit_clause = "" if limit is None else "LIMIT ? OFFSET ?"
        params: list[Any] = [session_id]
        if limit is not None:
            params.extend([limit, offset])
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"SELECT * FROM messages WHERE session_id = ? {active_clause} ORDER BY id {limit_clause}",
                params,
            ).fetchall()
        return [dict(row) for row in rows]


def create_fixture(path: Path) -> FixtureSessionDB:
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE sessions (
              id TEXT PRIMARY KEY,
              parent_session_id TEXT,
              started_at REAL NOT NULL,
              end_reason TEXT
            );
            CREATE TABLE messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id TEXT NOT NULL,
              role TEXT NOT NULL,
              content TEXT,
              timestamp REAL NOT NULL,
              active INTEGER NOT NULL DEFAULT 1,
              tool_calls TEXT,
              reasoning_content TEXT
            );
            """
        )
        conn.execute("INSERT INTO sessions VALUES ('root', NULL, 1, 'compression')")
        conn.execute("INSERT INTO sessions VALUES ('child', 'root', 2, NULL)")

        timestamp = 100.0
        for index in range(24):
            role = "user" if index % 2 == 0 else "assistant"
            conn.execute(
                "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
                ("root", role, f"root-{index:02d}", timestamp),
            )
            timestamp += 1
        conn.execute(
            "INSERT INTO messages (session_id, role, content, timestamp, tool_calls) VALUES (?, ?, ?, ?, ?)",
            ("root", "assistant", "", timestamp, "[]"),
        )
        timestamp += 1
        conn.execute(
            "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
            ("root", "tool", "internal tool output", timestamp),
        )

        child_rows = [
            ("assistant", "summary before marker"),
            ("user", "[CONTEXT COMPACTION - REFERENCE ONLY] hidden summary"),
            ("assistant", "summary after marker"),
            ("user", "child-user-00"),
            ("assistant", "child-assistant-00"),
            ("user", "child-user-01"),
            ("assistant", "child-assistant-01"),
            ("user", "[ASYNC DELEGATION BATCH COMPLETE]\ninternal worker reports"),
            ("assistant", "automatic synthesis"),
        ]
        for role, content in child_rows:
            timestamp += 1
            conn.execute(
                "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
                ("child", role, content, timestamp),
            )
        conn.commit()
    return FixtureSessionDB(path)


class MessagePaginationTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db = create_fixture(Path(self.tempdir.name) / "state.db")
        self.open_session = patch.object(hermes_sessions, "open_session", return_value=(self.db, "root"))
        self.open_session.start()

    def tearDown(self):
        self.open_session.stop()
        self.tempdir.cleanup()

    def test_tail_pages_reassemble_exact_legacy_projection(self):
        legacy = hermes_sessions.project_session_messages("root", "task-1")["messages"]
        page = hermes_sessions.project_session_message_page("root", "task-1", limit=7)

        self.assertEqual(page["messages"], legacy[-7:])
        self.assertTrue(page["pageInfo"]["hasOlder"])
        self.assertIsNotNone(page["pageInfo"]["olderCursor"])

        assembled = page["messages"]
        cursors: set[str] = set()
        while page["pageInfo"]["hasOlder"]:
            cursor = page["pageInfo"]["olderCursor"]
            self.assertNotIn(cursor, cursors, "pagination cursor must always move toward older rows")
            cursors.add(cursor)
            page = hermes_sessions.project_session_message_page("root", "task-1", limit=7, before=cursor)
            assembled = page["messages"] + assembled

        self.assertEqual(assembled, legacy)
        self.assertEqual(len({message["id"] for message in assembled}), len(assembled))
        self.assertEqual([message["created_at"] for message in assembled], sorted(message["created_at"] for message in assembled))

    def test_child_compaction_projection_matches_legacy_behavior(self):
        messages = hermes_sessions.project_session_messages("root", "task-1")["messages"]
        contents = [message["content"] for message in messages]
        self.assertIn(hermes_sessions.COMPACTION_MARKER_TEXT, contents)
        self.assertNotIn("summary before marker", contents)
        self.assertNotIn("summary after marker", contents)
        self.assertNotIn("[ASYNC DELEGATION BATCH COMPLETE]\ninternal worker reports", contents)
        self.assertEqual(contents[-5:], [
            "child-user-00",
            "child-assistant-00",
            "child-user-01",
            "child-assistant-01",
            "automatic synthesis",
        ])

    def test_invalid_limits_and_cursors_are_rejected(self):
        for limit in (0, 101, True, 1.5, "not-an-int"):
            with self.subTest(limit=limit), self.assertRaises(WorkerError):
                hermes_sessions.project_session_message_page("root", limit=limit)
        with self.assertRaises(WorkerError):
            hermes_sessions.project_session_message_page("root", before="not-a-cursor")

    def test_worker_request_keeps_unpaginated_default_for_existing_callers(self):
        calls: list[tuple[str, Any]] = []

        def full(session_id, task_id=None):
            calls.append(("full", (session_id, task_id)))
            return {"messages": [{"id": "all"}]}

        def page(session_id, task_id=None, limit=None, before=None):
            calls.append(("page", (session_id, task_id, limit, before)))
            return {"messages": [{"id": "tail"}], "pageInfo": {"hasOlder": False, "olderCursor": None}}

        output = io.StringIO()
        with (
            patch.object(hermes_worker, "project_session_messages", side_effect=full),
            patch.object(hermes_worker, "project_session_message_page", side_effect=page),
            patch.object(hermes_worker, "PROTOCOL_OUT", output),
            contextlib.redirect_stdout(output),
        ):
            hermes_worker._handle_request({"id": "legacy", "type": "session.messages.get", "sessionId": "session"})
            hermes_worker._handle_request({
                "id": "paged",
                "type": "session.messages.get",
                "sessionId": "session",
                "taskId": "task",
                "limit": 40,
                "before": "cursor",
            })

        results = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(calls, [
            ("full", ("session", None)),
            ("page", ("session", "task", 40, "cursor")),
        ])
        self.assertEqual(results[0]["data"], {"messages": [{"id": "all"}]})
        self.assertEqual(results[1]["data"]["pageInfo"], {"hasOlder": False, "olderCursor": None})


if __name__ == "__main__":
    unittest.main()
