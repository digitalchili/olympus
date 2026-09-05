from __future__ import annotations

import sys
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

WORKER_DIR = Path(__file__).resolve().parents[1] / "server" / "workers"
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

import hermes_worker  # noqa: E402


class FakeAgent:
    def __init__(self) -> None:
        self.steers: list[str] = []

    def steer(self, message: str) -> bool:
        self.steers.append(message)
        return True


class DeadlineBudgetTests(unittest.TestCase):
    def test_projects_valid_server_budget(self) -> None:
        budget = hermes_worker._run_budget({
            "runBudget": {
                "maxRuntimeMs": 120_000,
                "finalizeBeforeMs": 30_000,
                "childDrainBeforeMs": 10_000,
                "maxDelegatedChildren": 2,
            }
        })
        self.assertEqual(budget.max_runtime_seconds, 120)
        self.assertEqual(budget.finalize_before_seconds, 30)
        self.assertEqual(budget.child_drain_before_seconds, 10)
        self.assertEqual(budget.max_delegated_children, 2)

    def test_hard_deadline_bounds_remaining_worker_runtime(self) -> None:
        with patch.object(hermes_worker.time, "time", return_value=100.0):
            budget = hermes_worker._run_budget({
                "runBudget": {
                    "maxRuntimeMs": 120_000,
                    "hardDeadlineAtMs": 110_000,
                    "finalizeBeforeMs": 5_000,
                    "childDrainBeforeMs": 2_000,
                    "maxDelegatedChildren": 2,
                }
            })
        self.assertEqual(budget.max_runtime_seconds, 10)

        with patch.object(hermes_worker.time, "time", return_value=100.0):
            reserve_budget = hermes_worker._run_budget({
                "runBudget": {
                    "maxRuntimeMs": 120_000,
                    "hardDeadlineAtMs": 103_000,
                    "finalizeBeforeMs": 5_000,
                    "childDrainBeforeMs": 2_000,
                    "maxDelegatedChildren": 2,
                }
            })
        self.assertEqual(reserve_budget.max_runtime_seconds, 3)
        self.assertEqual(reserve_budget.finalize_before_seconds, 5)

    def test_rejects_new_delegation_after_reserve_or_total_cap(self) -> None:
        agent = types.SimpleNamespace(
            _olympus_delegate_spawn_deadline=10.0,
            _olympus_delegate_limit=4,
            _olympus_delegated_children_used=0,
        )
        allowed, _ = hermes_worker._reserve_delegation_capacity(agent, 3, now=9.0)
        self.assertTrue(allowed)
        allowed, message = hermes_worker._reserve_delegation_capacity(agent, 2, now=9.0)
        self.assertFalse(allowed)
        self.assertIn("4", message)
        allowed, message = hermes_worker._reserve_delegation_capacity(agent, 1, now=10.0)
        self.assertFalse(allowed)
        self.assertIn("finalization", message.lower())

    def test_soft_deadline_steers_parent_and_children_then_drains_children(self) -> None:
        parent = FakeAgent()
        child_ids = {"child-a", "child-b"}
        steered_children: list[tuple[str, str]] = []
        interrupted_children: list[str] = []
        delegate_tool = types.SimpleNamespace(
            steer_subagent=lambda child_id, message: steered_children.append((child_id, message)) or True,
            interrupt_subagent=lambda child_id: interrupted_children.append(child_id) or True,
        )
        budget = hermes_worker.RunBudget(
            max_runtime_seconds=0.08,
            finalize_before_seconds=0.06,
            child_drain_before_seconds=0.02,
            max_delegated_children=4,
        )
        controls = hermes_worker._start_deadline_controls(
            parent,
            lambda: set(child_ids),
            budget,
            delegate_tool=delegate_tool,
        )
        try:
            time.sleep(0.09)
        finally:
            controls.cancel()

        self.assertEqual(parent.steers, [
            hermes_worker.OLYMPUS_DEADLINE_FINALIZE_MESSAGE,
            hermes_worker.OLYMPUS_DEADLINE_DRAIN_MESSAGE,
        ])
        self.assertEqual({child_id for child_id, _ in steered_children}, child_ids)
        self.assertEqual(set(interrupted_children), child_ids)
        self.assertTrue(getattr(parent, "_olympus_delegate_closed"))
        self.assertTrue(controls.finalization_started.is_set())

    def test_internal_deadline_steer_never_becomes_a_fresh_user_turn(self) -> None:
        internal = hermes_worker.OLYMPUS_DEADLINE_DRAIN_MESSAGE
        self.assertIsNone(hermes_worker._strip_internal_deadline_steers(internal))
        self.assertEqual(
            hermes_worker._strip_internal_deadline_steers(f"User correction\n{internal}"),
            "User correction",
        )

    def test_native_hermes_budget_and_checkpoints_are_enabled_when_supported(self) -> None:
        kwargs: dict[str, object] = {}
        budget = hermes_worker.RunBudget(max_runtime_seconds=900)
        hermes_worker._apply_native_run_budget_kwargs(
            kwargs,
            {"run_budget_seconds", "checkpoints_enabled", "checkpoint_max_snapshots"},
            budget,
        )
        self.assertEqual(kwargs["run_budget_seconds"], 900)
        self.assertEqual(kwargs["checkpoints_enabled"], True)
        self.assertEqual(kwargs["checkpoint_max_snapshots"], 20)

    def test_deadline_error_uses_structured_worker_payload(self) -> None:
        self.assertEqual(
            hermes_worker._deadline_finalized_event(),
            {
                "type": "error",
                "error": {
                    "code": "deadline_finalized",
                    "message": "Olympus reached the finalization reserve. Partial progress was preserved; continue the unfinished work in a fresh run.",
                },
            },
        )

    def test_installed_delegate_guard_rejects_over_budget_spawn_but_allows_control(self) -> None:
        calls: list[dict[str, object]] = []

        def original_delegate_task(
            goal: object = None,
            tasks: object = None,
            action: object = None,
            parent_agent: object = None,
            **kwargs: object,
        ) -> str:
            calls.append({
                "goal": goal,
                "tasks": tasks,
                "action": action,
                "parent_agent": parent_agent,
                **kwargs,
            })
            return "ok"

        fake_delegate_tool = types.SimpleNamespace(
            delegate_task=original_delegate_task,
            tool_error=lambda message: f"error:{message}",
        )
        real_import = hermes_worker.importlib.import_module
        hermes_worker.importlib.import_module = lambda name: (
            fake_delegate_tool if name == "tools.delegate_tool" else real_import(name)
        )
        try:
            hermes_worker._install_delegate_run_budget_guard()
            agent = types.SimpleNamespace(
                _olympus_delegate_spawn_deadline=time.monotonic() + 100.0,
                _olympus_delegate_limit=1,
                _olympus_delegated_children_used=0,
            )
            rejected = fake_delegate_tool.delegate_task(
                None,
                [{"goal": "a"}, {"goal": "b"}],
                None,
                agent,
            )
            self.assertIn("at most 1", rejected)
            self.assertEqual(calls, [])

            rejected_json = fake_delegate_tool.delegate_task(
                tasks='[{"goal":"a"},{"goal":"b"}]',
                parent_agent=agent,
            )
            self.assertIn("at most 1", rejected_json)
            self.assertEqual(calls, [])

            failed_calls = 0
            def failing_delegate_task(
                goal: object = None,
                tasks: object = None,
                action: object = None,
                parent_agent: object = None,
                **_kwargs: object,
            ) -> str:
                nonlocal failed_calls
                failed_calls += 1
                return '{"error":"spawn rejected"}'
            fake_delegate_tool.delegate_task = failing_delegate_task
            setattr(fake_delegate_tool, "_olympus_budget_guard_original", None)
            hermes_worker._install_delegate_run_budget_guard()
            rollback_agent = types.SimpleNamespace(
                _olympus_delegate_spawn_deadline=time.monotonic() + 100.0,
                _olympus_delegate_limit=1,
                _olympus_delegated_children_used=0,
            )
            failed = fake_delegate_tool.delegate_task(goal="a", parent_agent=rollback_agent)
            self.assertIn("spawn rejected", failed)
            self.assertEqual(failed_calls, 1)
            self.assertEqual(rollback_agent._olympus_delegated_children_used, 0)

            fake_delegate_tool.delegate_task = original_delegate_task
            setattr(fake_delegate_tool, "_olympus_budget_guard_original", None)
            hermes_worker._install_delegate_run_budget_guard()
            controlled = fake_delegate_tool.delegate_task(
                action="list",
                parent_agent=agent,
            )
            self.assertEqual(controlled, "ok")
            self.assertEqual(len(calls), 1)
        finally:
            hermes_worker.importlib.import_module = real_import


if __name__ == "__main__":
    unittest.main()