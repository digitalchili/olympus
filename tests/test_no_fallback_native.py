"""Verify the selected Hermes release interprets an empty fallback chain correctly."""
import os
import sys
import unittest
from types import SimpleNamespace

SOURCE = os.environ.get('OLYMPUS_NATIVE_HERMES_SOURCE')


@unittest.skipUnless(SOURCE, 'native Hermes source not selected')
class NoFallbackNativeTests(unittest.TestCase):
    def test_empty_chain_disables_native_model_fallback(self):
        sys.path.insert(0, SOURCE)
        from agent.agent_init_fallback import _init_fallback_chain
        agent = SimpleNamespace(quiet_mode=True)
        _init_fallback_chain(agent, [])
        self.assertEqual(agent._fallback_chain, [])
        self.assertIsNone(agent._fallback_model)


if __name__ == '__main__':
    unittest.main()
