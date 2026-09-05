from __future__ import annotations

import json
import sys
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

WORKER_DIR = Path(__file__).resolve().parents[1] / "server" / "workers"
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

import hermes_worker  # noqa: E402


class FakeProcessRegistry:
    def __init__(self) -> None:
        self.calls: list[tuple[str | None, str | None]] = []

    def list_sessions(self, task_id: str | None = None, session_key: str | None = None) -> list[dict[str, object]]:
        self.calls.append((task_id, session_key))
        return [
            {
                "session_id": "proc-1",
                "status": "running",
                "command": "SECRET COMMAND MUST NOT LEAK",
                "output_preview": "SECRET OUTPUT MUST NOT LEAK",
            },
            {"session_id": "proc-2", "status": "exited"},
            {"session_id": "bad id!", "status": "running"},
        ]

    def kill_process(self, _session_id: str) -> None:  # pragma: no cover - must never be called
        raise AssertionError("background work inspection must be read-only")


class BackgroundWorkRpcTests(unittest.TestCase):
    def test_reports_only_task_owned_active_work_with_safe_identifiers(self) -> None:
        async_delegation = types.SimpleNamespace(
            _records_lock=threading.RLock(),
            _records={
                "deleg-1": {
                    "delegation_id": "deleg-1",
                    "session_key": "task-1",
                    "status": "running",
                    "goal": "SECRET GOAL MUST NOT LEAK",
                },
                "deleg-2": {
                    "delegation_id": "deleg-2",
                    "parent_session_id": "task-1",
                    "status": "finalizing",
                },
                "deleg-3": {
                    "delegation_id": "deleg-3",
                    "session_key": "task-1",
                    "status": "completed",
                },
                "deleg-4": {
                    "delegation_id": "deleg-4",
                    "session_key": "other-task",
                    "status": "running",
                },
            },
        )
        registry = FakeProcessRegistry()

        result = hermes_worker._session_background_work(
            {"sessionId": "task-1"},
            process_registry=registry,
            async_delegation=async_delegation,
        )

        self.assertTrue(result["available"])
        self.assertEqual(registry.calls, [("task-1", "task-1")])
        self.assertEqual(
            result["work"],
            [
                {"id": "proc-1", "kind": "process", "status": "running"},
                {"id": "deleg-1", "kind": "delegation", "status": "running"},
                {"id": "deleg-2", "kind": "delegation", "status": "finalizing"},
            ],
        )
        serialized = json.dumps(result)
        self.assertNotIn("SECRET", serialized)
        self.assertNotIn("proc-2", serialized)
        self.assertNotIn("deleg-3", serialized)
        self.assertNotIn("deleg-4", serialized)

    def test_returns_unavailable_when_native_registries_cannot_be_inspected(self) -> None:
        class BrokenRegistry:
            def list_sessions(self, **_kwargs: object) -> list[dict[str, object]]:
                raise RuntimeError("registry unavailable")

        result = hermes_worker._session_background_work(
            {"sessionId": "task-1"},
            process_registry=BrokenRegistry(),
            async_delegation=object(),
        )

        self.assertEqual(result, {"available": False, "work": []})

    def test_rpc_dispatches_session_background_work_get(self) -> None:
        sent: list[tuple[str, dict[str, object]]] = []
        payload = {"available": True, "work": [{"id": "proc-1", "kind": "process", "status": "running"}]}

        with (
            patch.object(hermes_worker, "_session_background_work", return_value=payload) as background_work,
            patch.object(hermes_worker, "_result", side_effect=lambda request_id, data: sent.append((request_id, data))),
        ):
            hermes_worker._handle_request({"id": "req-1", "type": "session.backgroundWork.get", "sessionId": "task-1"})

        background_work.assert_called_once_with({"id": "req-1", "type": "session.backgroundWork.get", "sessionId": "task-1"})
        self.assertEqual(sent, [("req-1", payload)])


if __name__ == "__main__":
    unittest.main()
