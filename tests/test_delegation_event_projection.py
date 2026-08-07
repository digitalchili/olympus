from __future__ import annotations

import json
import queue
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

WORKER_DIR = Path(__file__).resolve().parents[1] / "server" / "workers"
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

import hermes_worker  # noqa: E402
from hermes_worker import (  # noqa: E402
    background_delegation_id,
    background_delegation_was_dispatched,
    project_delegation_event,
    take_owned_delegation_notification,
)


class FakeProcessRegistry:
    def __init__(self, *events: dict[str, object]) -> None:
        self.completion_queue: queue.Queue[dict[str, object]] = queue.Queue()
        for event in events:
            self.completion_queue.put(event)


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

    def test_detects_only_successful_background_dispatch_results(self) -> None:
        string_result = '{"status":"dispatched","mode":"background","delegation_id":"deleg-1"}'
        dict_result = {"status": "dispatched", "delegation_id": "deleg-2"}
        self.assertEqual(background_delegation_id(string_result), "deleg-1")
        self.assertEqual(background_delegation_id(dict_result), "deleg-2")
        self.assertTrue(background_delegation_was_dispatched(string_result))
        self.assertFalse(background_delegation_was_dispatched({"status": "dispatched"}))
        self.assertFalse(background_delegation_was_dispatched('{"status":"completed"}'))
        self.assertFalse(background_delegation_was_dispatched("not-json"))
        self.assertFalse(background_delegation_was_dispatched(None))

    def test_takes_only_the_owned_async_delegation_notification(self) -> None:
        foreign = {"type": "async_delegation", "session_key": "task-2", "delegation_id": "foreign"}
        ordinary = {"type": "completion", "session_key": "task-1", "session_id": "process-1"}
        stale = {"type": "async_delegation", "session_key": "task-1", "delegation_id": "stale"}
        owned = {"type": "async_delegation", "session_key": "task-1", "delegation_id": "owned"}
        registry = FakeProcessRegistry(foreign, ordinary, stale, owned)

        selected = take_owned_delegation_notification(
            "task-1",
            delegation_ids={"owned"},
            registry=registry,
            timeout=0,
        )

        self.assertIs(selected, owned)
        remaining = [registry.completion_queue.get_nowait() for _ in range(3)]
        self.assertCountEqual(remaining, [foreign, ordinary, stale])

    def test_matches_origin_session_when_session_key_is_missing(self) -> None:
        owned = {"type": "async_delegation", "origin_session_id": "task-1", "delegation_id": "owned"}
        registry = FakeProcessRegistry(owned)
        self.assertIs(
            take_owned_delegation_notification("task-1", registry=registry, timeout=0),
            owned,
        )

    def test_parent_agent_continues_after_background_delegation_completes(self) -> None:
        run_messages: list[str] = []
        sent: list[dict[str, object]] = []
        completed_claims: list[tuple[dict[str, object], str]] = []
        event: dict[str, object] = {
            "type": "async_delegation",
            "session_key": "task-1",
            "delegation_id": "deleg-1",
        }

        class FakeAgent:
            session_id = "task-1"
            context_compressor = None
            _interrupt_requested = False
            tool_progress_callback = None

            def run_conversation(self, *, user_message: str, **_kwargs: object) -> dict[str, object]:
                run_messages.append(user_message)
                if len(run_messages) == 1:
                    assert self.tool_progress_callback is not None
                    self.tool_progress_callback(
                        "tool.completed",
                        "delegate_task",
                        None,
                        None,
                        duration=0.1,
                        is_error=False,
                        result='{"status":"dispatched","mode":"background","delegation_id":"deleg-1"}',
                    )
                    return {"final_response": "Workers are running."}
                return {"final_response": "Combined recommendation."}

        agent = FakeAgent()

        def create_agent(**kwargs: object) -> FakeAgent:
            callbacks = kwargs["callbacks"]
            assert isinstance(callbacks, dict)
            agent.tool_progress_callback = callbacks["tool_progress_callback"]
            return agent

        fake_async = types.ModuleType("tools.async_delegation")
        fake_async.claim_event_delivery = lambda selected, owner: "claim-1"
        fake_async.complete_event_delivery = lambda selected, claim: completed_claims.append((selected, claim))
        fake_async.release_event_delivery = lambda selected, claim: None

        fake_registry = FakeProcessRegistry()
        fake_process = types.ModuleType("tools.process_registry")
        fake_process.process_registry = fake_registry
        fake_process.format_process_notification = lambda selected: "[ASYNC DELEGATION BATCH COMPLETE]\nreports"

        with (
            patch.object(hermes_worker, "open_session", return_value=(object(), "task-1")),
            patch.object(hermes_worker, "load_agent_history", return_value=[]),
            patch.object(hermes_worker, "_create_agent", side_effect=create_agent),
            patch.object(hermes_worker, "take_owned_delegation_notification", return_value=event),
            patch.object(hermes_worker, "_send", side_effect=sent.append),
            patch.dict(sys.modules, {
                "tools.async_delegation": fake_async,
                "tools.process_registry": fake_process,
            }),
        ):
            hermes_worker._run_chat("request-1", {
                "taskId": "task-1",
                "taskTitle": "Compare platforms",
                "sessionId": "task-1",
                "message": "Research three platforms.",
                "systemMessage": "Test system message",
            })

        self.assertEqual(run_messages, [
            "Research three platforms.",
            "[ASYNC DELEGATION BATCH COMPLETE]\nreports",
        ])
        self.assertEqual(completed_claims, [(event, "claim-1")])
        self.assertEqual([item["type"] for item in sent].count("done"), 1)
        streamed = "".join(str(item.get("content") or "") for item in sent if item["type"] == "text_delta")
        self.assertIn("Workers are running.", streamed)
        self.assertIn("Combined recommendation.", streamed)


if __name__ == "__main__":
    unittest.main()
