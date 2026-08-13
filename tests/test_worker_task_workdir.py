import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

WORKER_DIR = Path(__file__).resolve().parents[1] / "server" / "workers"
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

import hermes_worker  # noqa: E402
from hermes_worker_utils import WorkerError  # noqa: E402


class TaskWorkdirTests(unittest.TestCase):
    def test_registers_and_clears_task_scoped_workspace(self) -> None:
        registered: list[tuple[str, dict[str, str]]] = []
        cleared: list[str] = []
        terminal_tool = types.ModuleType("tools.terminal_tool")
        terminal_tool.register_task_env_overrides = lambda task_id, overrides: registered.append((task_id, overrides))
        terminal_tool.clear_task_env_overrides = cleared.append

        with tempfile.TemporaryDirectory() as root, patch.dict(sys.modules, {"tools.terminal_tool": terminal_tool}):
            workspace = str(Path(root).resolve())
            hermes_worker._apply_task_workdir({
                "sessionId": "ordinary-session",
                "taskId": "ordinary-task",
            })
            self.assertEqual(cleared, [], "ordinary tasks keep their existing Hermes session CWD")

            hermes_worker._apply_task_workdir({
                "sessionId": "session-1",
                "taskId": "task-1",
                "workdir": workspace,
            })
            self.assertEqual(registered, [
                ("session-1", {"cwd": workspace}),
                ("task-1", {"cwd": workspace}),
            ])

            hermes_worker._apply_task_workdir({
                "sessionId": "session-1",
                "taskId": "task-1",
            })
            self.assertEqual(cleared, ["session-1", "task-1"])

    def test_rejects_non_absolute_or_missing_workspace(self) -> None:
        for workdir in ("relative/path", "/definitely/missing/olympus-workspace"):
            with self.subTest(workdir=workdir):
                with self.assertRaises(WorkerError):
                    hermes_worker._apply_task_workdir({
                        "sessionId": "session-1",
                        "taskId": "task-1",
                        "workdir": workdir,
                    })


if __name__ == "__main__":
    unittest.main()
