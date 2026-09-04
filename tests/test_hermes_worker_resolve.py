#!/usr/bin/env python3
"""Regression tests for _resolve_model_provider (managed custom-provider routing).

Catalog model ids like "anthropic/claude-sonnet-5" must stay on a configured
custom: provider (the managed Agent37 starter proxy) instead of being re-routed
to the built-in openrouter provider, which holds no credentials on managed
instances (HTTP 401 "User not found").
"""

import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

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
    def test_olympus_caps_tool_iterations_below_hermes_default(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OLYMPUS_AGENT_MAX_ITERATIONS", None)
            self.assertEqual(hermes_worker._agent_max_iterations(), 40)

        with patch.dict(os.environ, {"OLYMPUS_AGENT_MAX_ITERATIONS": "12"}):
            self.assertEqual(hermes_worker._agent_max_iterations(), 12)

        with patch.dict(os.environ, {"OLYMPUS_AGENT_MAX_ITERATIONS": "invalid"}):
            self.assertEqual(hermes_worker._agent_max_iterations(), 40)

    def test_incomplete_agent_result_is_not_reported_as_success(self):
        self.assertEqual(
            hermes_worker._agent_result_failure({
                "completed": False,
                "failed": False,
                "turn_exit_reason": "max_iterations_reached(40)",
            }),
            ("Hermes reached the Olympus tool-iteration limit before completing this turn.", "iteration_limit"),
        )
        self.assertEqual(
            hermes_worker._agent_result_failure({"completed": False, "failed": True, "error": "provider failed"}),
            ("provider failed", "agent_failed"),
        )
        self.assertIsNone(hermes_worker._agent_result_failure({"completed": True, "failed": False}))

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

    def test_curated_remote_catalog_does_not_add_model_missing_from_credential_inventory(self):
        cfg = {"model": {"default": "gpt-5.6-sol", "provider": "openai-codex"}}
        defaults = hermes_worker._defaults_from_config(cfg)
        authenticated = {
            "OpenAI Codex": [{
                "id": "gpt-5.6-sol",
                "label": "gpt-5.6-sol",
                "source": "catalog",
                "provider": "openai-codex",
                "isCurrentDefault": True,
            }],
        }
        manifest = {
            "version": 1,
            "models": [
                {"provider": "openai-codex", "id": "gpt-6-astra", "label": "GPT-6 Astra"},
            ],
        }

        merged = hermes_worker._merge_curated_model_catalog(authenticated, manifest, defaults)

        self.assertEqual(
            [item["id"] for item in merged["OpenAI Codex"]],
            ["gpt-5.6-sol"],
        )

    def test_curated_remote_catalog_can_label_credential_verified_model(self):
        cfg = {"model": {"default": "gpt-5.6-sol", "provider": "openai-codex"}}
        defaults = hermes_worker._defaults_from_config(cfg)
        authenticated = {
            "OpenAI Codex": [
                {
                    "id": "gpt-5.6-sol",
                    "label": "gpt-5.6-sol",
                    "source": "catalog",
                    "provider": "openai-codex",
                    "isCurrentDefault": True,
                },
                {
                    "id": "gpt-6-astra",
                    "label": "gpt-6-astra",
                    "source": "catalog",
                    "provider": "openai-codex",
                    "isCurrentDefault": False,
                },
            ],
        }
        manifest = {
            "version": 1,
            "models": [
                {"provider": "openai-codex", "id": "gpt-6-astra", "label": "GPT-6 Astra"},
            ],
        }

        merged = hermes_worker._merge_curated_model_catalog(authenticated, manifest, defaults)

        astra = merged["OpenAI Codex"][1]
        self.assertEqual(astra["label"], "GPT-6 Astra")
        self.assertEqual(astra["source"], "catalog")
        self.assertEqual(astra["provider"], "openai-codex")

    def test_requested_model_resolution_preserves_explicit_settings(self):
        agent = SimpleNamespace(
            model="gpt-5.5",
            provider="openai-codex",
            reasoning_config={"enabled": True, "effort": "high"},
        )
        self.assertEqual(
            hermes_worker._requested_model_resolution(
                agent,
                "gpt-6-astra",
                "openai-codex",
                "xhigh",
            ),
            {
                "model": "gpt-6-astra",
                "provider": "openai-codex",
                "reasoningEffort": "xhigh",
            },
        )
        self.assertEqual(
            hermes_worker._requested_model_resolution(agent, None, None, None),
            {
                "model": "gpt-5.5",
                "provider": "openai-codex",
                "reasoningEffort": "high",
            },
        )

    def test_model_resolution_payload_preserves_request_and_reports_fallback_actual(self):
        requested = {
            "model": "gpt-6-astra",
            "provider": "openai-codex",
            "reasoningEffort": "xhigh",
        }
        agent = SimpleNamespace(
            model="gpt-5.5",
            provider="openai-codex",
            reasoning_config={"enabled": True, "effort": "high"},
        )

        payload = hermes_worker._model_resolution_payload(
            agent,
            requested,
            fallback_reason="Primary model failed; Hermes activated its configured fallback.",
        )

        self.assertEqual(payload, {
            "requested": requested,
            "actual": {
                "model": "gpt-5.5",
                "provider": "openai-codex",
                "reasoningEffort": "high",
            },
            "fallbackReason": "Primary model failed; Hermes activated its configured fallback.",
        })
        inferred = hermes_worker._model_resolution_payload(agent, requested)
        self.assertEqual(
            inferred["fallbackReason"],
            "Requested model settings were not used; Hermes resolved the run to a different configuration.",
        )

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
