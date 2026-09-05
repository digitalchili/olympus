from __future__ import annotations

import contextlib
import json
import os
import shlex
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

WORKER_DIR = Path(__file__).resolve().parents[1] / "server" / "workers"
NATIVE_SOURCE = os.environ.get("OLYMPUS_NATIVE_HERMES_SOURCE")
for path in ([WORKER_DIR, Path(NATIVE_SOURCE)] if NATIVE_SOURCE else [WORKER_DIR]):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import hermes_background_work  # noqa: E402


@contextlib.contextmanager
def isolated_hermes_home():
    keys = ["HOME", "HERMES_HOME", "TERMINAL_ENV"]
    old = {key: os.environ.get(key) for key in keys}
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp)
        hermes_home = home / "hermes-home"
        hermes_home.mkdir()
        os.environ["HOME"] = str(home)
        os.environ["HERMES_HOME"] = str(hermes_home)
        os.environ["TERMINAL_ENV"] = "local"
        try:
            yield home
        finally:
            for key, value in old.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


class FakeProcessRegistry:
    def __init__(self, by_scope: dict[str, list[dict[str, object]]] | None = None) -> None:
        self.calls: list[tuple[str | None, str | None]] = []
        self.by_scope = by_scope or {
            "task-1": [
                {
                    "session_id": "proc-1",
                    "status": "running",
                    "command": "SECRET COMMAND MUST NOT LEAK",
                    "output_preview": "SECRET OUTPUT MUST NOT LEAK",
                },
                {"session_id": "proc-2", "status": "exited"},
                {"session_id": "bad id!", "status": "running"},
            ],
        }

    def list_sessions(self, task_id: str | None = None, session_key: str | None = None) -> list[dict[str, object]]:
        self.calls.append((task_id, session_key))
        return list(self.by_scope.get(str(task_id), []))

    def kill_process(self, _session_id: str) -> None:  # pragma: no cover - inspection must be read-only
        raise AssertionError("background work inspection must be read-only")


class FakeAsyncDelegation:
    def __init__(self) -> None:
        self._records_lock = threading.RLock()
        self._records = {
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
        }


class BackgroundWorkNativeTests(unittest.TestCase):
    def test_reports_only_owned_active_work_with_safe_identifiers(self) -> None:
        registry = FakeProcessRegistry()
        async_delegation = FakeAsyncDelegation()

        with patch.object(hermes_background_work, "_lineage_aliases", side_effect=lambda value: [value]):
            result = hermes_background_work.get_background_work(
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
        self.assertNotIn("bad id!", serialized)
        self.assertNotIn("proc-2", serialized)
        self.assertNotIn("deleg-3", serialized)
        self.assertNotIn("deleg-4", serialized)

    def test_real_readonly_lineage_includes_children_and_fails_closed_on_corruption(self):
        import sqlite3
        with isolated_hermes_home():
            path = Path(os.environ["HERMES_HOME"]) / "state.db"
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT)")
                db.executemany("INSERT INTO sessions VALUES (?,?)", [("root", None), ("compressed", "root"), ("child", "compressed"), ("unrelated", None)])
            self.assertEqual(set(hermes_background_work._lineage_aliases("root")), {"root", "compressed", "child"})
            path.write_text("not a database")
            self.assertEqual(hermes_background_work.get_background_work({"sessionId":"root"}, process_registry=FakeProcessRegistry(), async_delegation=FakeAsyncDelegation()), {"available": False, "work": []})

    def test_queries_compression_aliases_without_returning_other_sessions(self) -> None:
        registry = FakeProcessRegistry(
            {
                "task-root": [],
                "task-live": [{"session_id": "proc-live", "status": "running"}],
            }
        )
        async_delegation = FakeAsyncDelegation()
        with async_delegation._records_lock:
            async_delegation._records = {
                "deleg-live": {
                    "delegation_id": "deleg-live",
                    "parent_session_id": "task-live",
                    "status": "running",
                },
                "deleg-other": {
                    "delegation_id": "deleg-other",
                    "session_key": "other-task",
                    "status": "running",
                },
            }

        with patch.object(
            hermes_background_work,
            "_lineage_aliases",
            side_effect=lambda value: ["task-root", "task-live"] if value == "task-root" else [value],
        ):
            result = hermes_background_work.get_background_work(
                {"sessionId": "task-root"},
                process_registry=registry,
                async_delegation=async_delegation,
            )

        self.assertEqual(registry.calls, [("task-root", "task-root"), ("task-live", "task-live")])
        self.assertEqual(
            result,
            {
                "available": True,
                "work": [
                    {"id": "proc-live", "kind": "process", "status": "running"},
                    {"id": "deleg-live", "kind": "delegation", "status": "running"},
                ],
            },
        )

    def test_returns_unavailable_when_native_registry_shapes_are_unsupported(self) -> None:
        class BrokenRegistry:
            def list_sessions(self, **_kwargs: object) -> list[dict[str, object]]:
                raise RuntimeError("registry unavailable")

        with patch.object(hermes_background_work, "_lineage_aliases", side_effect=lambda value: [value]):
            self.assertEqual(
                hermes_background_work.get_background_work(
                    {"sessionId": "task-1"},
                    process_registry=BrokenRegistry(),
                    async_delegation=FakeAsyncDelegation(),
                ),
                {"available": False, "work": []},
            )
            self.assertEqual(
                hermes_background_work.get_background_work(
                    {"sessionId": "task-1"},
                    process_registry=FakeProcessRegistry({"task-1": []}),
                    async_delegation=object(),
                ),
                {"available": False, "work": []},
            )

    @unittest.skipUnless(NATIVE_SOURCE, "native Hermes source not selected")
    def test_cold_worker_jsonl_inventory_rpc_without_model_calls(self):
        import subprocess
        with isolated_hermes_home():
            env = dict(os.environ, HERMES_AGENT_DIR=str(NATIVE_SOURCE))
            request = {"id": "inventory-probe", "type": "session.backgroundWork.get", "sessionId": "new-task"}
            worker = Path(os.environ.get("OLYMPUS_WORKER_TEST_DIR", str(WORKER_DIR))) / "hermes_worker.py"
            result = subprocess.run([sys.executable, str(worker)], input=json.dumps(request)+"\n", text=True, capture_output=True, env=env, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr[-500:])
            messages = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
            response = next(item for item in messages if item.get("id") == "inventory-probe")
            self.assertEqual(response["type"], "result")
            self.assertEqual(response["data"], {"available": True, "work": []})

    @unittest.skipUnless(NATIVE_SOURCE, "native Hermes source not selected")
    def test_native_process_registry_smoke_filters_other_task_without_leaking_command(self) -> None:
        with isolated_hermes_home() as home:
            from tools import async_delegation  # type: ignore
            from tools.process_registry import process_registry  # type: ignore

            python = shlex.quote(sys.executable)
            own = process_registry.spawn_local(
                f"{python} -c 'import time; time.sleep(20)' # SECRET_NATIVE_COMMAND",
                cwd=str(home),
                task_id="task-native",
                session_key="task-native",
            )
            other = process_registry.spawn_local(
                f"{python} -c 'import time; time.sleep(20)'",
                cwd=str(home),
                task_id="other-task",
                session_key="other-task",
            )
            try:
                result = hermes_background_work.get_background_work(
                    {"sessionId": "task-native"},
                    process_registry=process_registry,
                    async_delegation=async_delegation,
                )
                if not result["available"]:
                    hermes_background_work._lineage_aliases("task-native")
                self.assertTrue(result["available"])
                process_ids = [item["id"] for item in result["work"] if item["kind"] == "process"]
                self.assertIn(own.id, process_ids)
                self.assertNotIn(other.id, process_ids)
                self.assertNotIn("SECRET_NATIVE_COMMAND", json.dumps(result))
            finally:
                for session in (own, other):
                    process_registry.kill_process(
                        session.id,
                        source="test_background_work_native",
                        consume_output=False,
                    )


if __name__ == "__main__":
    unittest.main()
