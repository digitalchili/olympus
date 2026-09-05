"""Opt-in native Hermes builder seam: no credentials and no model calls.
Run with OLYMPUS_NATIVE_HERMES_SOURCE and the installed Hermes Python.
"""
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SOURCE = os.environ.get("OLYMPUS_NATIVE_HERMES_SOURCE")
WORKERS = Path(__file__).resolve().parents[1] / "server" / "workers"
sys.path.insert(0, str(WORKERS))

@unittest.skipUnless(SOURCE, "native Hermes source not selected")
class NativeReasoningTests(unittest.TestCase):
    def test_installed_builder_receives_safe_child_not_mutated_parent(self):
        assert SOURCE is not None
        sys.path.insert(0, SOURCE)
        import hermes_worker
        import tools.delegate_tool as native
        import run_agent
        cfg: dict = {"model": "gpt-5.5", "reasoning_effort": ""}
        parent = SimpleNamespace(model="gpt-6-astra", provider="openai-codex",
            reasoning_config={"enabled": True, "effort": "max"},
            enabled_toolsets=[], session_id="native-parent", api_key=None, base_url=None)
        observed = []
        def capture(**kwargs):
            self.assertEqual(parent.reasoning_config["effort"], "max")
            observed.append(kwargs)
            return SimpleNamespace(session_id="native-child", tools=[])
        original = native._build_child_agent
        try:
            with patch.object(native, "_load_config", return_value=cfg), patch.object(run_agent, "AIAgent", side_effect=capture):
                hermes_worker._install_delegate_child_reasoning_compat()
                self.assertIsNot(native._build_child_agent, original)
                native._build_child_agent(0, "test-only", None, [], "gpt-5.5", 1, 1, parent, "openai-codex")
                self.assertEqual(observed[-1]["reasoning_config"], {"enabled": True, "effort": "xhigh"})
                self.assertEqual(observed[-1]["provider"], "openai-codex")
                cfg["reasoning_effort"] = "high"
                native._build_child_agent(0, "test-only", None, [], "gpt-5.5", 1, 1, parent, "openai-codex")
                self.assertEqual(observed[-1]["reasoning_config"]["effort"], "high")
                cfg["reasoning_effort"] = False
                native._build_child_agent(0, "test-only", None, [], "gpt-5.5", 1, 1, parent, "openai-codex")
                self.assertEqual(observed[-1]["reasoning_config"], {"enabled": False})
        finally:
            native._build_child_agent = original

if __name__ == "__main__":
    unittest.main()
