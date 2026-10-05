import io
import json
import os
from pathlib import Path
import sys
import unittest
import types
from contextlib import ExitStack, nullcontext
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server/workers'))
from hermes_performance import PerformanceTrace

TRACE = '00000000-0000-4000-8000-000000000001'


class PerformanceTests(unittest.TestCase):
    def test_disabled_and_invalid_ids_are_silent(self):
        for enabled, identifier in [('0', TRACE), ('1', '/private/SECRET'), ('1', None)]:
            with patch.dict(os.environ, {'OLYMPUS_PERF_DIAGNOSTICS': enabled}), patch('sys.stderr', new_callable=io.StringIO) as output:
                trace = PerformanceTrace(identifier)
                trace.mark('dispatched')
                trace.finish('done')
                self.assertEqual(output.getvalue(), '')

    def test_fixed_stages_monotonic_and_idempotent_terminal(self):
        now, records = [1.0], []
        with patch.dict(os.environ, {'OLYMPUS_PERF_DIAGNOSTICS': '1'}):
            trace = PerformanceTrace(TRACE, clock=lambda: now[0], write=records.append)
            trace.mark('dispatched')
            now[0] = 1.04; trace.mark('slot_acquired')
            now[0] = 1.12; trace.mark('native_started')
            now[0] = 1.15; trace.mark('first_activity'); trace.mark('first_text')
            now[0] = 1.18; trace.mark('first_text'); trace.mark('/private/SECRET')
            trace.mark('cleaned_up'); trace.finish('stopped'); trace.finish('done')
        rows = [json.loads(line.removeprefix('[olympus-perf] ')) for line in records]
        self.assertEqual(next(row['elapsedMs'] for row in rows if row.get('stage') == 'slot_acquired'), 40)
        self.assertEqual(next(row['elapsedMs'] for row in rows if row.get('stage') == 'first_text'), 150)
        self.assertEqual(next(row.get('nativeFirstOutputMs') for row in rows if row.get('stage') == 'first_activity'), 30)
        self.assertEqual(sum(row.get('stage') == 'first_text' for row in rows), 1)
        self.assertEqual(rows[-1]['outcome'], 'stopped')
        self.assertNotIn('SECRET', ''.join(records))
        self.assertNotIn('history_ready', ''.join(records))

    def test_real_chat_setup_and_callbacks_mark_distinct_stages(self):
        import hermes_worker as worker
        records, sent = [], []
        class Agent:
            context_compressor = None
            def __init__(self, **kwargs):
                self.__dict__.update(kwargs)
            def run_conversation(self, **kwargs):
                self.reasoning_callback('PRIVATE thinking')
                self.stream_delta_callback('')
                self.stream_delta_callback('PRIVATE text')
                self.stream_delta_callback('more')
                return {'completed': True, 'final_response': 'PRIVATE textmore'}
        runtime = types.ModuleType('hermes_cli.runtime_provider')
        runtime.resolve_runtime_provider = lambda **kwargs: {'provider': 'openai-codex', 'api_key': 'SECRET'}
        journal = MagicMock()
        journal.context.return_value = ''
        journal.rows.return_value = []
        journal.receipt.return_value = {}
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {'OLYMPUS_PERF_DIAGNOSTICS': '1'}))
            stack.enter_context(patch.dict(sys.modules, {'hermes_cli.runtime_provider': runtime}))
            for name, value in {
                '_ensure_imports': lambda: None, 'install_native_guard': lambda: None,
                '_install_delegate_child_reasoning_compat': lambda: None,
                '_register_mcp_servers': lambda cfg: None,
                '_load_config': lambda: {'model': {'provider': 'openai-codex', 'default': 'fixture'}},
                '_resolve_toolsets': lambda cfg: [], '_SessionDB': None, '_AIAgent': Agent,
                '_AIAgent_PARAMS': {'session_id', 'model', 'provider', 'api_key', 'stream_delta_callback', 'reasoning_callback'},
                'open_session': lambda sid: (None, sid), 'load_agent_history': lambda *args: [],
                'ContinuationJournal': lambda _: journal, 'native_approval_context': lambda *args: nullcontext(),
                '_send': sent.append,
            }.items():
                stack.enter_context(patch.object(worker, name, value))
            trace = PerformanceTrace(TRACE, write=records.append)
            worker._run_chat('request', {'sessionId': 'fixture', 'message': 'PRIVATE'}, performance_trace=trace)
        stages = [json.loads(line.removeprefix('[olympus-perf] '))['stage'] for line in records]
        self.assertEqual(stages, ['history_ready', 'mcp_ready', 'runtime_ready', 'agent_ready', 'native_started', 'first_activity', 'first_text'])
        self.assertNotIn('PRIVATE', ''.join(records))
        self.assertNotIn('SECRET', ''.join(records))

    def test_logging_failure_cannot_fail_work(self):
        with patch.dict(os.environ, {'OLYMPUS_PERF_DIAGNOSTICS': '1'}):
            trace = PerformanceTrace(TRACE, write=lambda _: (_ for _ in ()).throw(ValueError('sink')))
            trace.mark('first_text'); trace.finish('error')

    def test_worker_queue_and_cleanup_timing_use_the_request_trace(self):
        import hermes_worker as worker
        def run(_rid, _request, performance_trace=None, pending_steers=None):
            self.assertIsNotNone(performance_trace)
            self.assertEqual(pending_steers, [])
            performance_trace.mark('history_ready')
            return [{'id': 'request', 'type': 'done', 'interrupted': True}]
        with patch.dict(os.environ, {'OLYMPUS_PERF_DIAGNOSTICS': '1'}), \
                patch('sys.stderr', new_callable=io.StringIO) as output, \
                patch.object(worker, '_run_chat', side_effect=run), patch.object(worker, '_send'):
            worker._run_chat_thread('request', {'timingTraceId': TRACE}, 'task')
        rows = [json.loads(line.removeprefix('[olympus-perf] ')) for line in output.getvalue().splitlines()]
        self.assertEqual([row.get('stage') for row in rows[:-1]], ['dispatched', 'slot_acquired', 'history_ready', 'cleaned_up'])
        self.assertEqual(rows[-1]['outcome'], 'stopped')


if __name__ == '__main__':
    unittest.main()
