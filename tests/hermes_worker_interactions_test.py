"""Worker-side interaction invariants; no provider, live profile or command execution."""
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server" / "workers"))
from hermes_interactions import InteractionBroker, InteractionError
import hermes_interactions as interactions
from types import ModuleType
from unittest.mock import patch


class InteractionTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.ready = threading.Event()
        def send(event):
            self.events.append(event)
            if event["type"] == "interaction_requested":
                self.ready.set()
        self.broker = InteractionBroker(send, redact=lambda text: text.replace("secret-token", "[REDACTED]"))
        self.pool = ThreadPoolExecutor(max_workers=4)
        self.interrupted = []

    def tearDown(self):
        self.broker.cancel_run("turn-1")
        self.broker.cancel_run("turn-2")
        self.pool.shutdown(wait=True)

    def begin(self, **kwargs):
        future = self.pool.submit(self.broker.clarify, "task-1", "turn-1", interrupt=self.interrupted.append, **kwargs)
        self.assertTrue(self.ready.wait(2))
        event = next(e["interaction"] for e in self.events if e["type"] == "interaction_requested")
        return future, event

    def answer(self, event, response, **overrides):
        request = {"taskId": "task-1", "workerRunId": "turn-1", "interactionId": event["id"], "response": response}
        request.update(overrides)
        return self.broker.respond(request)

    def test_single_question_waits_for_exact_answer_not_assumptions(self):
        future, event = self.begin(question="Which?", choices=["One", "Two"])
        self.assertFalse(future.done())
        qid = event["questions"][0]["id"]
        self.assertEqual(self.answer(event, {"answers": {qid: "Other answer"}}), {"accepted": True})
        self.assertEqual(future.result(2), "Other answer")
        self.assertEqual(self.events[-1]["status"], "answered")
        self.assertFalse(self.interrupted)

    def test_native_batched_qids_and_multiselect_roundtrip(self):
        future, event = self.begin(question="Decisions", questions=[
            {"qid": "mode", "question": "Select", "choices": ["A", "B"], "multi_select": True},
            {"qid": "notes", "question": "Details", "choices": [], "multi_select": False},
        ])
        answers = {"mode": ["A", "Other"], "notes": "Real user answer"}
        self.answer(event, {"answers": answers})
        self.assertEqual(future.result(2), {"answers": answers})

    def test_invalid_incomplete_unknown_or_oversized_answers_do_not_consume(self):
        future, event = self.begin(question="Value?")
        qid = event["questions"][0]["id"]
        for response in [{"answers": {}}, {"answers": {qid: ""}}, {"answers": {qid: []}},
                         {"answers": {qid: "ok", "extra": "bad"}}, {"answers": {qid: "x" * 10001}},
                         {"answers": {qid: "ok"}, "decision": "once"}]:
            with self.assertRaises(InteractionError) as raised:
                self.answer(event, response)
            self.assertEqual(raised.exception.code, "interaction_invalid")
        self.assertFalse(future.done())
        self.answer(event, {"answers": {qid: "Valid"}})
        self.assertEqual(future.result(2), "Valid")

    def test_wrong_task_run_and_replay_fail_closed(self):
        future, event = self.begin(question="Value?")
        response = {"answers": {event["questions"][0]["id"]: "Yes"}}
        for override in [{"taskId": "other"}, {"workerRunId": "turn-2"}]:
            with self.assertRaises(InteractionError): self.answer(event, response, **override)
        self.answer(event, response)
        future.result(2)
        with self.assertRaises(InteractionError): self.answer(event, response)

    def test_approval_is_once_or_deny_and_redacts_display(self):
        future = self.pool.submit(self.broker.approve, "task-1", "turn-1", "run secret-token", "Reason secret-token", interrupt=self.interrupted.append)
        self.assertTrue(self.ready.wait(2))
        event = self.events[0]["interaction"]
        self.assertNotIn("secret-token", str(event))
        for choice in ["always", "session", "yes", True]:
            with self.assertRaises(InteractionError): self.answer(event, {"decision": choice})
        self.answer(event, {"decision": "once"})
        self.assertEqual(future.result(2), "once")
        self.assertEqual(self.events[-1]["status"], "answered")

    def test_denied_approval_never_approves(self):
        future = self.pool.submit(self.broker.approve, "task-1", "turn-1", "target", "reason", interrupt=self.interrupted.append)
        self.assertTrue(self.ready.wait(2))
        self.answer(self.events[0]["interaction"], {"decision": "deny"})
        self.assertEqual(future.result(2), "deny")
        self.assertEqual(self.events[-1]["status"], "denied")

    def test_expiry_interrupts_turn_and_cannot_be_answered(self):
        future, event = self.begin(question="Wait?", timeout_seconds=0.02)
        with self.assertRaises(InteractionError): future.result(2)
        self.assertTrue(self.interrupted)
        self.assertEqual(self.events[-1]["status"], "expired")
        with self.assertRaises(InteractionError): self.answer(event, {"answers": {"q1": "late"}})

    def test_stop_cancels_exact_run_and_unblocks_waiters(self):
        future, event = self.begin(question="Wait?")
        self.broker.cancel_run("turn-2")
        self.assertFalse(future.done())
        self.broker.cancel_run("turn-1")
        with self.assertRaises(InteractionError): future.result(2)
        self.assertEqual(self.events[-1]["status"], "cancelled")
        self.assertTrue(self.interrupted)

    def test_legacy_runtime_chat_continues_without_global_approval_context(self):
        tools = ModuleType("tools")
        tools.approval = ModuleType("tools.approval")
        tools.terminal_tool = ModuleType("tools.terminal_tool")
        with patch.dict(sys.modules, {"tools": tools}):
            with interactions.native_approval_context(lambda *a: "once", "legacy"):
                # Chat still runs, but tools requiring an unsafe/missing gate do not.
                self.assertIn("terminal", interactions.interaction_disabled_toolsets())
                self.assertIn("computer_use", interactions.interaction_disabled_toolsets())

    def test_redaction_failure_never_emits_raw_payload(self):
        def fail(text): raise RuntimeError("redactor unavailable")
        broker = InteractionBroker(self.events.append, redact=fail)
        with self.assertRaises(InteractionError):
            broker.approve("task-1", "turn-1", "secret-token", "reason", interrupt=self.interrupted.append)
        self.assertEqual(self.events, [])
        self.assertTrue(self.interrupted)


if __name__ == "__main__":
    unittest.main()
