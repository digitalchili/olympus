"""Model notices must reflect the run's native route, not auxiliary status text."""
import sys
import types
import unittest
from contextlib import ExitStack, nullcontext
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server/workers'))
import hermes_worker as worker


class ModelResolutionTests(unittest.TestCase):
    def run_statuses(self, statuses):
        sent = []

        class Agent:
            context_compressor = None
            def __init__(self, **kwargs):
                self.__dict__.update(kwargs)
            def run_conversation(self, **kwargs):
                for model, activated, message in statuses:
                    self.model = model
                    self._fallback_activated = activated
                    self.status_callback('diagnostic', message)
                return {'completed': True, 'final_response': 'Done'}

        runtime = types.ModuleType('hermes_cli.runtime_provider')
        runtime.resolve_runtime_provider = lambda **kw: {'provider': 'openai-codex', 'api_key': 'fixture'}
        journal = MagicMock()
        journal.context.return_value = ''
        journal.rows.return_value = []
        journal.receipt.return_value = {}
        with ExitStack() as stack:
            stack.enter_context(patch.dict(sys.modules, {'hermes_cli.runtime_provider': runtime}))
            for name, value in {
                '_ensure_imports': lambda: None, 'install_native_guard': lambda: None,
                '_install_delegate_child_reasoning_compat': lambda: None,
                '_register_mcp_servers': lambda cfg: None,
                '_load_config': lambda: {'model': {'provider': 'openai-codex', 'default': 'gpt-6-astra'}},
                '_resolve_toolsets': lambda cfg: [], '_SessionDB': None, '_AIAgent': Agent,
                '_AIAgent_PARAMS': {'session_id', 'model', 'provider', 'api_key', 'status_callback'},
                'open_session': lambda sid: (None, sid), 'load_agent_history': lambda *args: [],
                'ContinuationJournal': lambda _: journal, 'native_approval_context': lambda *args: nullcontext(),
                '_send': sent.append,
            }.items():
                stack.enter_context(patch.object(worker, name, value))
            result = worker._run_chat('request', {'sessionId': 'fixture', 'message': 'Hello'})
        return [e['modelResolution'] for e in sent + result if 'modelResolution' in e]

    def test_auxiliary_fallback_failure_never_claims_primary_switch(self):
        resolutions = self.run_statuses([
            ('gpt-6-astra', False, 'Compression fallback failed: PRIVATE upstream details'),
        ])
        self.assertTrue(resolutions)
        self.assertTrue(all('fallbackReason' not in r for r in resolutions))
        self.assertEqual(len(resolutions), 2, 'unchanged status does not repeat initial and final model metadata')
        self.assertNotIn('PRIVATE', str(resolutions))

    def test_native_switch_is_visible_and_primary_restore_clears_reason(self):
        resolutions = self.run_statuses([
            ('gpt-5.5', True, 'Model fallback activated'),
            ('gpt-6-astra', False, 'Primary restored; fallback is no longer active'),
        ])
        fallback = next(r for r in resolutions if r['actual']['model'] == 'gpt-5.5')
        self.assertEqual(fallback['fallbackReason'], 'Hermes is using its configured fallback model.')
        self.assertNotIn('fallbackReason', resolutions[-1])

    def test_initialization_fallback_uses_native_state_without_status_callback(self):
        agent = types.SimpleNamespace(model='gpt-5.5', provider='openai-codex', _fallback_activated=True)
        result = worker._model_resolution_payload(agent, {'model': 'gpt-6-astra', 'provider': 'openai-codex'})
        self.assertEqual(result['fallbackReason'], 'Hermes is using its configured fallback model.')


if __name__ == '__main__':
    unittest.main()
