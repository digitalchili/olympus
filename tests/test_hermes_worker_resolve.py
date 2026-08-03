#!/usr/bin/env python3
"""Regression tests for _resolve_model_provider (managed custom-provider routing).

Catalog model ids like "anthropic/claude-sonnet-5" must stay on a configured
custom: provider (the managed Agent37 starter proxy) instead of being re-routed
to the built-in openrouter provider, which holds no credentials on managed
instances (HTTP 401 "User not found").
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server" / "workers"))

import hermes_worker
import hermes_sessions

PROXY_URL = "https://www.agent37.com/api/openclaw/starter-proxy/v1"

MANAGED_CFG = {
    "model": {"default": "default", "provider": "custom:agent37"},
    "custom_providers": [
        {
            "name": "Agent37",
            "base_url": PROXY_URL,
            "api_key": "token",
            "api_mode": "chat_completions",
            "model": "default",
        }
    ],
}


class ResolveModelProviderTest(unittest.TestCase):
    def test_explicit_custom_provider_honored_for_catalog_model(self):
        result = hermes_worker._resolve_model_provider(
            "anthropic/claude-sonnet-5", MANAGED_CFG, requested_provider="custom:agent37"
        )
        self.assertEqual(result, ("anthropic/claude-sonnet-5", "custom:agent37", PROXY_URL))

    def test_config_custom_provider_honored_without_explicit_provider(self):
        result = hermes_worker._resolve_model_provider("openai/gpt-4o-mini", MANAGED_CFG)
        self.assertEqual(result, ("openai/gpt-4o-mini", "custom:agent37", PROXY_URL))

    def test_default_model_unchanged(self):
        result = hermes_worker._resolve_model_provider(
            "default", MANAGED_CFG, requested_provider="custom:agent37"
        )
        self.assertEqual(result, ("default", "custom:agent37", PROXY_URL))

    def test_explicit_openrouter_still_routes_to_openrouter(self):
        model, provider, _ = hermes_worker._resolve_model_provider(
            "anthropic/claude-sonnet-5", MANAGED_CFG, requested_provider="openrouter"
        )
        self.assertEqual((model, provider), ("anthropic/claude-sonnet-5", "openrouter"))

    def test_at_provider_syntax_still_overrides_config_provider(self):
        model, provider, _ = hermes_worker._resolve_model_provider(
            "@openrouter:anthropic/claude-sonnet-5", MANAGED_CFG
        )
        self.assertEqual((model, provider), ("anthropic/claude-sonnet-5", "openrouter"))

    def test_openrouter_config_provider_unchanged(self):
        cfg = {"model": {"default": "anthropic/claude-sonnet-5", "provider": "openrouter"}}
        model, provider, _ = hermes_worker._resolve_model_provider("anthropic/claude-sonnet-5", cfg)
        self.assertEqual((model, provider), ("anthropic/claude-sonnet-5", "openrouter"))

    def test_unapplied_steer_is_drained_for_guaranteed_follow_up(self):
        class FakeAgent:
            def _drain_pending_steer(self):
                return "Follow-up that missed the final tool call"

        self.assertEqual(
            hermes_worker._drain_unapplied_steer(FakeAgent()),
            "Follow-up that missed the final tool call",
        )

    def test_applied_steer_is_persisted_as_trusted_display_only_row(self):
        class FakeAgent:
            pending = ["Applied steer", "Late steer"]

            def _drain_pending_steer(self):
                return self.pending.pop(0)

        class FakeSessionDB:
            appended = []

            def append_message(self, *args, **kwargs):
                self.appended.append((args, kwargs))

        agent = FakeAgent()
        session_db = FakeSessionDB()
        hermes_worker._install_steer_delivery_recorder(agent, session_db, "session-1")

        self.assertEqual(agent._drain_pending_steer(), "Applied steer")
        self.assertEqual(
            session_db.appended,
            [(('session-1', 'user', 'Applied steer'), {
                'display_kind': 'olympus_steer',
                'display_metadata': {'source': 'olympus_steer'},
            })],
        )
        self.assertEqual(hermes_worker._drain_unapplied_steer(agent), "Late steer")
        self.assertEqual(len(session_db.appended), 1)

    def test_display_only_steer_is_not_replayed_to_model(self):
        history = [
            {"role": "user", "content": "Initial"},
            {"role": "user", "content": "Applied steer", "display_kind": "olympus_steer"},
            {"role": "assistant", "content": "Done"},
        ]
        self.assertEqual(
            hermes_sessions._sanitize_agent_history(history),
            [
                {"role": "user", "content": "Initial"},
                {"role": "assistant", "content": "Done"},
            ],
        )

    def test_retired_agent_rejects_late_steer(self):
        class FakeAgent:
            def steer(self, _message):
                return True

        task_key = "late-steer-task"
        request_id = "late-steer-request"
        hermes_worker.ACTIVE_TASKS[task_key] = request_id
        hermes_worker._register_active_agent(task_key, request_id, FakeAgent())
        hermes_worker._unregister_active_agent(task_key, request_id)
        try:
            self.assertEqual(
                hermes_worker._steer_active_chat({"taskId": task_key, "message": "too late"}),
                {"steered": False},
            )
        finally:
            hermes_worker._clear_task_active(task_key, request_id)


if __name__ == "__main__":
    unittest.main()
