"""Bot transport contracts without providers, live profiles or native subprocesses."""
import copy
import json
import os
import subprocess
import sys
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server' / 'workers'))
from hermes_bot_messaging import BotMessageBroker, BotMessageError, configure_bot_agent, install_native_guard

SCHEMA = {'type': 'function', 'function': {'name': 'message_agent', 'parameters': {
    'type': 'object', 'properties': {'target': {'type': 'string'}, 'message': {'type': 'string'}},
    'required': ['target', 'message']}}}

class BotMessagingTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.ready = threading.Event()
        def send(event):
            self.events.append(event)
            self.ready.set()
        self.broker = BotMessageBroker(send, timeout_seconds=1)
        self.pool = ThreadPoolExecutor(max_workers=3)
        self.native = ModuleType('tools.bot_mode_dm')
        self.native.message_agent_tool_schema = lambda: copy.deepcopy(SCHEMA)
        self.original = self.native.message_agent_tool = Mock(side_effect=AssertionError('Native transport must never run'))
        self.mcp = ModuleType('tools.mcp_tool')
        self.mcp._reinject_post_build_tools = lambda agent, tools, names: set()
        self.modules = patch.dict(sys.modules, {'tools': ModuleType('tools'),
            'tools.bot_mode_dm': self.native, 'tools.mcp_tool': self.mcp})
        self.modules.start()
        self.agent = self.configure('task-a', 'run-a')

    def configure(self, task, run, *, profile='alpha', peers=None, deadline=None):
        agent = SimpleNamespace(tools=[], valid_tool_names=set(), _interrupt_requested=False)
        configure_bot_agent(agent, {'profileId': profile, 'peers': peers or [{'id': 'beta', 'label': 'Beta'}]},
                            self.broker, task, run, deadline or time.monotonic() + 5)
        return agent

    def tearDown(self):
        self.broker.cancel_run('run-a')
        self.broker.cancel_run('run-b')
        self.pool.shutdown(wait=True)
        self.original.assert_not_called()
        self.modules.stop()

    def begin(self, agent=None):
        future = self.pool.submit(self.native.message_agent_tool, 'beta', 'Please check this.', agent=agent or self.agent)
        self.assertTrue(self.ready.wait(2))
        return future, self.events[-1]['botMessage']

    def respond(self, request, result=None, **overrides):
        return self.broker.respond({'taskId': 'task-a', **request,
            'result': result or {'accepted': True, 'messageId': 'durable-1'}, **overrides})

    def test_native_schema_only_on_explicit_bot_and_ack_waits_for_durable_receipt(self):
        self.assertEqual(self.agent.tools[0]['function']['parameters'], SCHEMA['function']['parameters'])
        self.assertIn('message_agent', self.agent.valid_tool_names)
        self.assertFalse(self.agent._bot_mode_protocol)
        future, request = self.begin()
        self.assertFalse(future.done())
        self.assertEqual(self.events[0]['id'], 'run-a')
        self.assertEqual(request['workerRunId'], 'run-a')
        self.assertEqual(request['target'], 'beta')
        self.respond(request)
        result = json.loads(future.result(2))
        self.assertTrue(result['accepted'])
        self.assertEqual(result['messageId'], 'durable-1')

    def test_wrong_task_run_request_and_missing_receipt_cannot_authorize_delivery(self):
        future, request = self.begin()
        for changes in [{'taskId': 'other'}, {'workerRunId': 'run-b'}, {'requestId': 'other'},
                        {'result': {'accepted': True}}, {'result': {'accepted': 'yes'}}]:
            with self.assertRaises(BotMessageError): self.respond(request, **changes)
        self.assertFalse(future.done())
        self.respond(request, {'accepted': False, 'error': 'Recipient is inactive'})
        self.assertIn('inactive', json.loads(future.result(2))['error'])
        with self.assertRaises(BotMessageError): self.respond(request)

    def test_interrupt_unblocks_wait_and_late_ack_or_calls_are_rejected(self):
        future, request = self.begin()
        self.broker.cancel_run('run-a')
        self.assertFalse(json.loads(future.result(1))['accepted'])
        with self.assertRaises(BotMessageError): self.respond(request)
        result = json.loads(self.native.message_agent_tool('beta', 'Again', agent=self.agent))
        self.assertFalse(result['accepted'])
        self.assertEqual(len(self.events), 1)

    def test_timeout_does_not_fall_back_or_claim_delivery(self):
        self.broker.timeout_seconds = .02
        future, request = self.begin()
        result = json.loads(future.result(1))
        self.assertFalse(result['accepted'])
        self.assertIn('Do not retry', result['error'])
        with self.assertRaises(BotMessageError): self.respond(request)

    def test_run_deadline_bounds_ack_wait(self):
        self.broker.cancel_run('run-a')
        self.agent = self.configure('task-a', 'run-a', deadline=time.monotonic() + .03)
        future, _ = self.begin()
        self.assertFalse(json.loads(future.result(1))['accepted'])

    def test_nonbot_self_remote_unknown_and_oversize_calls_are_denied(self):
        for target, message, agent in [('beta', 'x', SimpleNamespace()), ('alpha', 'x', self.agent),
                                      ('peer/beta', 'x', self.agent), ('unknown', 'x', self.agent),
                                      ('beta', 'x' * 12001, self.agent), ('beta', '', self.agent)]:
            result = json.loads(self.native.message_agent_tool(target, message, agent=agent))
            self.assertFalse(result['accepted'])
        self.assertEqual(self.events, [])
        wrapper = self.native.message_agent_tool
        install_native_guard()
        self.assertIs(self.native.message_agent_tool, wrapper)

    def test_message_size_matches_the_durable_server_boundary(self):
        for message in ['x' * 12001, '\U0001f680' * 6001]:
            rejected = json.loads(self.native.message_agent_tool('beta', message, agent=self.agent))
            self.assertFalse(rejected['accepted'])
            self.assertEqual(len(self.events), 0, 'oversize messages must not reach the server')
        for message in ['x' * 12000, '\U0001f680' * 6000]:
            self.ready.clear()
            future = self.pool.submit(self.native.message_agent_tool, 'beta', message, agent=self.agent)
            self.assertTrue(self.ready.wait(2))
            self.respond(self.events[-1]['botMessage'])
            self.assertTrue(json.loads(future.result(1))['accepted'])

    def test_parallel_runs_do_not_share_sender_or_ack(self):
        other = self.configure('task-b', 'run-b', profile='gamma')
        first, req1 = self.begin()
        self.ready.clear()
        second, req2 = self.begin(other)
        self.assertNotEqual(req1['requestId'], req2['requestId'])
        self.respond(req2, taskId='task-b', workerRunId='run-b')
        self.assertTrue(json.loads(second.result(1))['accepted'])
        self.assertFalse(first.done())
        self.respond(req1)
        self.assertTrue(json.loads(first.result(1))['accepted'])

    def test_missing_native_schema_fails_explicitly(self):
        del self.native.message_agent_tool_schema
        with self.assertRaises(BotMessageError): self.configure('task-b', 'run-b')

    def test_missing_native_refresh_hook_fails_explicitly(self):
        del self.mcp._reinject_post_build_tools
        with self.assertRaisesRegex(BotMessageError, 'tool refresh hook'):
            self.configure('task-b', 'run-b')

    def test_worker_ack_rpc_and_interrupt_use_the_bound_broker(self):
        import hermes_worker as worker
        future, request = self.begin()
        replies = []
        with patch.object(worker, 'BOT_MESSAGES', self.broker), patch.object(worker, '_result',
                side_effect=lambda identity, result: replies.append((identity, result))):
            worker._handle_request({'id': 'ack-1', 'type': 'bot.message.respond', 'taskId': 'task-a',
                                    **request, 'result': {'accepted': True, 'messageId': 'durable-rpc'}})
        self.assertEqual(replies, [('ack-1', {'accepted': True})])
        self.assertEqual(json.loads(future.result(1))['messageId'], 'durable-rpc')
        self.ready.clear()
        future, _ = self.begin()
        with patch.object(worker, 'BOT_MESSAGES', self.broker), patch.object(worker, 'ACTIVE_TASKS', {'task-a': 'run-a'}), \
                patch.object(worker, 'ACTIVE_AGENTS', {'task-a': self.agent}), patch.object(worker, 'ContinuationJournal'), \
                patch.object(worker, '_try_interrupt_agent', return_value=True):
            self.assertTrue(worker._interrupt_active_chat({'taskId': 'task-a'})['interrupted'])
        self.assertFalse(json.loads(future.result(1))['accepted'])

    def test_worker_terminal_cleanup_closes_bot_before_terminal_delivery(self):
        import hermes_worker as worker
        future, _ = self.begin()
        sent = []
        def terminal(event):
            sent.append(event)
            self.assertFalse(json.loads(self.native.message_agent_tool('beta', 'Too late', agent=self.agent))['accepted'])
        with patch.object(worker, 'BOT_MESSAGES', self.broker), patch.object(worker, '_clear_task_active'), \
                patch.object(worker, '_run_chat', return_value=[{'id': 'run-a', 'type': 'done'}]), \
                patch.object(worker, '_send', side_effect=terminal):
            worker._run_chat_thread('run-a', {}, 'task-a')
        self.assertFalse(json.loads(future.result(1))['accepted'])
        self.assertEqual(len(sent), 1)

@unittest.skipUnless(os.environ.get('OLYMPUS_NATIVE_HERMES_SOURCE'), 'native Hermes source not selected')
class NativeBotToolsTests(unittest.TestCase):
    def test_native_refresh_and_executor_preserve_only_authorized_bot_delivery(self):
        source = os.environ['OLYMPUS_NATIVE_HERMES_SOURCE']
        workers = str(Path(__file__).resolve().parents[1] / 'server' / 'workers')
        script = r'''
import sys, time, json
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, SOURCE)
sys.path.insert(0, WORKERS)
from hermes_bot_messaging import configure_bot_agent, BotMessageBroker
from tools import bot_mode_dm, mcp_tool
from agent import tool_executor
from agent.conversation_compression import _refresh_agent_tool_definitions

def fake_agent():
    return SimpleNamespace(tools=[], valid_tool_names=set(), _interrupt_requested=False,
        quiet_mode=True, verbose_logging=False, tool_progress_callback=None, tool_complete_callback=None,
        _should_emit_quiet_tool_messages=lambda: False,
        _append_guardrail_observation=lambda name, args, result, **kw: result,
        _touch_activity=lambda value: None,
        _subdirectory_hints=SimpleNamespace(check_tool_call=lambda name, args: ''),
        _tool_result_content_for_active_model=lambda name, result: result,
        _flush_messages_to_session_db=lambda messages: True)

agent = fake_agent()
events = []
def send(event):
    events.append(event)
    broker.respond({'taskId': 'task-a', **event['botMessage'],
                    'result': {'accepted': True, 'messageId': 'native-receipt'}})
broker = BotMessageBroker(send)
configure_bot_agent(agent, {'profileId': 'alpha', 'peers': [{'id': 'beta'}]},
                    broker, 'task-a', 'run-a', time.monotonic() + 30)
native_parameters = bot_mode_dm.message_agent_tool_schema()['function']['parameters']
assert agent.tools[0]['function']['parameters'] == native_parameters
refreshed_tool = {'type': 'function', 'function': {'name': 'refreshed_tool'}}
with patch('model_tools.get_tool_definitions', return_value=[refreshed_tool]) as rebuild:
    mcp_tool.refresh_agent_mcp_tools(agent)
    bot_mode_dm.ensure_message_agent_tool(agent)
    assert 'message_agent' in agent.valid_tool_names, 'MCP refresh removed Bot messaging'
    assert 'refreshed_tool' in agent.valid_tool_names, 'native refresh did not publish'
    rebuild.return_value = []
    _refresh_agent_tool_definitions(agent)
    assert 'message_agent' in agent.valid_tool_names, 'compaction removed Bot messaging'
    assert len(agent.tools) == 1, 'refresh duplicated the injected schema'
    assert agent.tools[0]['function']['parameters'] == native_parameters
    assert agent._bot_mode_protocol is False
    ordinary = fake_agent()
    mcp_tool.refresh_agent_mcp_tools(ordinary)
    assert 'message_agent' not in ordinary.valid_tool_names

# Keep native dispatch and canonical tool-result creation real. Skip provider,
# plugin and terminal plumbing; the only execution callback is the local broker.
def middleware(agent, **kwargs):
    result = kwargs['execute'](kwargs['function_args'])
    return tool_executor._ManagedToolResult(result, kwargs['function_args'], [], False, True)
call = SimpleNamespace(tool_calls=[SimpleNamespace(id='call-1', function=SimpleNamespace(
    name='message_agent', arguments=json.dumps({'target': 'beta', 'message': 'Please review'})))])
with patch.object(tool_executor, '_run_sequential_tool_execution_middleware', side_effect=middleware), \
     patch.object(tool_executor, '_emit_terminal_post_tool_call'), \
     patch.object(tool_executor, 'get_active_env', return_value=None), \
     patch.object(tool_executor, 'maybe_persist_tool_result', side_effect=lambda **kw: kw['content']):
    results = []
    tool_executor.execute_tool_calls_sequential(agent, call, results, 'task-a', finalize=False)
    assert results[-1]['role'] == 'tool'
    assert results[-1]['tool_call_id'] == 'call-1'
    assert json.loads(results[-1]['content']) == {'accepted': True, 'messageId': 'native-receipt'}
    results = []
    tool_executor.execute_tool_calls_sequential(ordinary, call, results, 'child-task', finalize=False)
    assert json.loads(results[-1]['content'])['accepted'] is False
    assert len(events) == 1, 'ordinary or child agent inherited Bot authority'
broker.cancel_run('run-a')
assert json.loads(bot_mode_dm.message_agent_tool('beta', 'late', agent=agent))['accepted'] is False
print('Native Bot MCP refresh, compaction, schema and executor contracts passed')
'''.replace('SOURCE', repr(source)).replace('WORKERS', repr(workers))
        result = subprocess.run([sys.executable, '-c', script], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__': unittest.main()
