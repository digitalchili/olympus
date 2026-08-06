from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parents[1] / "server" / "workers"
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

from hermes_worker import project_delegation_event  # noqa: E402


class DelegationEventProjectionTests(unittest.TestCase):
    def test_projects_only_closed_safe_schema(self) -> None:
        event = project_delegation_event(
            "subagent.tool",
            "web_search",
            {
                "subagent_id": "child-1",
                "child_session_id": "session-child-1",
                "parent_id": None,
                "task_index": 0,
                "task_count": 1,
                "model": "gpt-5.6-sol",
                "tool_count": 2,
                "api_calls": 1,
                "goal": "PRIVATE GOAL SENTINEL",
                "summary": "PRIVATE SUMMARY SENTINEL",
                "args": {"token": "PRIVATE ARG SENTINEL"},
                "output_tail": "PRIVATE OUTPUT SENTINEL",
                "files_read": ["/private/read.txt"],
                "files_written": ["/private/write.txt"],
            },
            parent_session_id="task-1",
            delegation_id="deleg-1",
        )
        self.assertIsNotNone(event)
        assert event is not None
        self.assertEqual(
            set(event),
            {
                "schema",
                "delegationId",
                "childId",
                "parentSessionId",
                "childSessionId",
                "parentChildId",
                "childIndex",
                "childCount",
                "status",
                "currentAction",
                "model",
                "toolCount",
                "apiCalls",
                "durationSeconds",
                "inputTokens",
                "outputTokens",
                "reasoningTokens",
                "costUsd",
                "filesTouched",
            },
        )
        self.assertEqual(event["status"], "running")
        self.assertEqual(event["currentAction"], "web_search")
        self.assertEqual(event["filesTouched"], 2)
        serialized = json.dumps(event)
        for forbidden in (
            "PRIVATE GOAL",
            "PRIVATE SUMMARY",
            "PRIVATE ARG",
            "PRIVATE OUTPUT",
            "/private/",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_maps_lifecycle_states_and_rejects_missing_identity(self) -> None:
        base = {
            "subagent_id": "child-1",
            "task_index": 0,
            "task_count": 1,
        }
        expected = {
            "subagent.spawn_requested": "queued",
            "subagent.start": "running",
            "subagent.progress": "waiting",
        }
        for event_type, status in expected.items():
            with self.subTest(event_type=event_type):
                event = project_delegation_event(
                    event_type,
                    None,
                    base,
                    parent_session_id="task-1",
                    delegation_id="deleg-1",
                )
                self.assertEqual(event["status"], status)

        for raw, normalized in {
            "completed": "completed",
            "failed": "failed",
            "error": "failed",
            "interrupted": "cancelled",
            "timeout": "timed_out",
            "stalled": "stalled",
        }.items():
            with self.subTest(raw=raw):
                event = project_delegation_event(
                    "subagent.complete",
                    None,
                    {**base, "status": raw},
                    parent_session_id="task-1",
                    delegation_id="deleg-1",
                )
                self.assertEqual(event["status"], normalized)

        self.assertIsNone(
            project_delegation_event(
                "subagent.start",
                None,
                {"task_index": 0, "task_count": 1},
                parent_session_id="task-1",
                delegation_id="deleg-1",
            )
        )


if __name__ == "__main__":
    unittest.main()
