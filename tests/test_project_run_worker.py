"""Project commands keep credentials on the server and authority on the root run."""
import json
import os
import subprocess
import tempfile
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server' / 'workers'))
import hermes_project_run as commands


class ProjectRunTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.ready = threading.Event()
        def send(event):
            self.events.append(event)
            self.ready.set()
        self.broker = commands.ProjectRunBroker(send)
        self.pool = ThreadPoolExecutor(max_workers=3)
        self.registry = ModuleType('tools.registry')
        self.registry.registry = SimpleNamespace(register=Mock())
        self.mcp = ModuleType('tools.mcp_tool_agent')
        self.mcp._reinject_post_build_tools = lambda agent, tools, names: {'native'}
        self.modules = patch.dict(sys.modules, {'tools': ModuleType('tools'), 'tools.registry': self.registry,
                                              'tools.mcp_tool_agent': self.mcp})
        self.modules.start()
        self.approval = patch.object(commands, '_approve_command', return_value=True)
        self.approve = self.approval.start()
        self.agent = self.configure('task-a', 'run-a', 'session-a')
        self.handler = self.registry.registry.register.call_args.kwargs['handler']

    def configure(self, task, run, session):
        agent = SimpleNamespace(tools=[], valid_tool_names={'terminal'}, _interrupt_requested=False, session_id=session)
        commands.configure_project_run_agent(agent, self.broker, task, run, session)
        return agent

    def tearDown(self):
        for run in ('run-a', 'run-b'): self.broker.cancel_run(run)
        self.pool.shutdown(wait=True)
        self.approval.stop()
        self.modules.stop()

    def begin(self, session='session-a'):
        self.ready.clear()
        future = self.pool.submit(self.handler, {'command': 'npm test', 'secrets': ['DATABASE_URL']}, task_id=session)
        self.assertTrue(self.ready.wait(2))
        return future, self.events[-1]['projectRun']

    def respond(self, request, **changes):
        return self.broker.respond({'taskId': 'task-a', **request,
            'result': {'ok': True, 'exitCode': 0, 'output': 'safe', 'truncated': False}, **changes})

    def test_names_only_request_closed_response_and_native_approval(self):
        future, req = self.begin()
        self.assertEqual(req['secrets'], ['DATABASE_URL'])
        self.assertNotIn('projectId', req)
        self.approve.assert_called_once_with('npm test')
        self.respond(req, result={'ok': True, 'exitCode': 0, 'output': 'safe', 'truncated': False,
                                  'env': {'DATABASE_URL': 'never-forward-this'}})
        self.assertEqual(json.loads(future.result(1)), {'ok': True, 'exitCode': 0, 'output': 'safe', 'truncated': False})

    def test_unauthorized_and_invalid_arguments_never_dispatch(self):
        for session in (None, '', 'child', 'task-a'):
            self.assertFalse(json.loads(self.handler({'command': 'env', 'secrets': ['KEY']}, task_id=session))['ok'])
        for args in ({'command': 'env', 'secrets': ['KEY'], 'projectId': 'other'},
                     {'command': 'env', 'secrets': []}, {'command': 'env', 'secrets': ['KEY=raw']},
                     {'command': 'env', 'secrets': ['KEY', 'KEY']}, {'command': '', 'secrets': ['KEY']}):
            self.assertFalse(json.loads(self.handler(args, task_id='session-a'))['ok'])
        self.assertEqual(self.events, [])
        self.approve.assert_not_called()

    def test_native_denial_and_missing_approval_fail_closed(self):
        self.approve.return_value = False
        self.assertFalse(json.loads(self.handler({'command': 'rm -rf /', 'secrets': ['KEY']}, task_id='session-a'))['ok'])
        self.approve.side_effect = ImportError('unsafe native error')
        self.assertNotIn('unsafe native error', self.handler({'command': 'echo x', 'secrets': ['KEY']}, task_id='session-a'))
        self.assertEqual(self.events, [])

    def test_parallel_sessions_stale_reply_and_stop(self):
        self.configure('task-b', 'run-b', 'session-b')
        first, req1 = self.begin()
        second, req2 = self.begin('session-b')
        with self.assertRaises(commands.ProjectRunError): self.respond(req1, taskId='task-b')
        self.respond(req2, taskId='task-b')
        self.assertTrue(json.loads(second.result(1))['ok'])
        self.assertFalse(first.done())
        self.broker.cancel_run('run-a')
        self.assertFalse(json.loads(first.result(1))['ok'])
        with self.assertRaises(commands.ProjectRunError): self.respond(req1)

    def test_refresh_and_continuation_keep_only_root_authority(self):
        for agent, allowed in ((self.agent, True), (SimpleNamespace(), False)):
            tools, names = [], set()
            self.mcp._reinject_post_build_tools(agent, tools, names)
            self.assertEqual('project_run' in names, allowed)
        self.agent.session_id = 'rotated'
        self.broker.continue_session(self.agent, 'run-a', 'rotated')
        self.assertFalse(json.loads(self.handler({'command': 'true', 'secrets': ['KEY']}, task_id='session-a'))['ok'])
        future, request = self.begin('rotated')
        self.respond(request)
        self.assertTrue(json.loads(future.result(1))['ok'])
        self.broker.cancel_run('run-a')
        tools, names = [], set()
        self.mcp._reinject_post_build_tools(self.agent, tools, names)
        self.assertNotIn('project_run', names)

    def test_disabled_terminal_never_grants_command_execution(self):
        agent = SimpleNamespace(tools=[], valid_tool_names=set(), session_id='no-terminal')
        commands.configure_project_run_agent(agent, self.broker, 'no-terminal', 'no-terminal-run', 'no-terminal')
        self.assertNotIn('project_run', agent.valid_tool_names)
        self.assertFalse(json.loads(self.handler({'command': 'true', 'secrets': ['KEY']}, task_id='no-terminal'))['ok'])

    def test_worker_stop_and_cleanup_remove_authority(self):
        import hermes_worker as worker
        self.agent.interrupt = Mock()
        future, _ = self.begin()
        with patch.object(worker, 'PROJECT_RUN', self.broker):
            self.assertTrue(worker._try_interrupt_agent(self.agent, 'Stopped'))
        self.assertFalse(json.loads(future.result(1))['ok'])
        self.agent = self.configure('task-a', 'run-a', 'session-a')
        future, _ = self.begin()
        with patch.object(worker, 'PROJECT_RUN', self.broker), patch.object(worker, '_clear_task_active'), \
                patch.object(worker, '_run_chat', return_value=[]):
            worker._run_chat_thread('run-a', {}, 'task-a')
        self.assertFalse(json.loads(future.result(1))['ok'])

@unittest.skipUnless(os.environ.get('OLYMPUS_NATIVE_HERMES_SOURCE'), 'native Hermes source not selected')
class NativeProjectRunTests(unittest.TestCase):
    def test_native_registry_compaction_and_mcp_refresh_preserve_authority(self):
        script = r'''
import asyncio, json, sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
sys.path.insert(0, SOURCE)
sys.path.insert(0, WORKERS)
from hermes_project_run import ProjectRunBroker, configure_project_run_agent, _approve_command
from hermes_interactions import native_approval_context
# Exercise actual native guard availability without execution, network or credentials.
with native_approval_context(lambda *args, **kwargs: 'deny', 'guard-check'):
    assert _approve_command('printf safe')
    assert not _approve_command('sleep 60 &')
from tools.registry import registry
try:
    from tools import mcp_tool_agent as mcp_tool
except ImportError:
    from tools import mcp_tool
from agent import conversation_compression as compression
from hermes_state import SessionDB

db = SessionDB()
db.create_session(session_id='session-a', source='test', model='native-test')
agent = SimpleNamespace(tools=[], valid_tool_names={'terminal'}, _interrupt_requested=False,
    session_id='session-a', model='native-test', _memory_manager=None, _session_db=db, compression_enabled=False,
    platform='test', _session_init_model_config={}, commit_memory_session=lambda messages: None,
    _emit_status=lambda *a: None, _emit_warning=lambda *a: None,
    _todo_store=SimpleNamespace(format_for_injection=lambda: ''),
    _invalidate_system_prompt=lambda: None, _build_system_prompt=lambda value: value,
    context_compressor=SimpleNamespace(compress=lambda *a, **kw: [{'role': 'user', 'content': 'summary'}],
                                       compression_count=1))
events=[]
def send(event):
    events.append(event)
    broker.respond({'taskId':'task-a', **event['projectRun'], 'result': {'ok': True, 'exitCode': 0, 'output': 'safe', 'truncated': False}})
broker=ProjectRunBroker(send)
configure_project_run_agent(agent, broker, 'task-a', 'run-a', 'session-a')
assert registry.get_definitions({'project_run'}, quiet=True) == [], 'global schema leaked to unrelated agents'
for session in ('session-a', 'child-session', None):
    result=json.loads(registry.dispatch('project_run', {'command':'printf safe', 'secrets':['TEST_KEY']}, task_id=session))
    assert result['ok'] is (session == 'session-a')
assert len(events)==1

if hasattr(mcp_tool, 'refresh_agent_mcp_tools'):
    with patch('model_tools.get_tool_definitions', return_value=[]):
        mcp_tool.refresh_agent_mcp_tools(agent)
        compression._refresh_agent_tool_definitions(agent)
    assert 'project_run' in agent.valid_tool_names
else:
    # The installed fixed-schema version runs real compaction bookkeeping,
    # with only the summarizer and file-read cache replaced (no provider call).
    old_tools = agent.tools
    with patch('tools.file_tools.reset_file_dedup'):
        compressed, _ = compression.compress_context(agent, [{'role':'user','content':'original'}], 'system', task_id='session-a')
    assert compressed[0]['content']=='summary'
    assert agent.tools is old_tools and 'project_run' in agent.valid_tool_names
    # Invoke the installed MCP registry-refresh method with an empty local
    # response; no MCP server, network, profile or credential access occurs.
    cls = next(value for value in vars(mcp_tool).values() if isinstance(value,type) and hasattr(value,'_refresh_tools'))
    server = SimpleNamespace(_refresh_lock=asyncio.Lock(), _rpc_lock=asyncio.Lock(),
        _registered_tool_names=set(), name='native-test', _config={},
        session=SimpleNamespace(list_tools=AsyncMock(return_value=SimpleNamespace(tools=[]))))
    with patch.object(mcp_tool, '_register_server_tools', return_value=set()):
        asyncio.run(cls._refresh_tools(server))
    assert agent.tools is old_tools and 'project_run' in agent.valid_tool_names

if not hasattr(mcp_tool, 'refresh_agent_mcp_tools'):
    assert agent.session_id != 'session-a', 'real SessionDB compaction did not rotate session'
    assert db.get_session(agent.session_id)['parent_session_id'] == 'session-a'
    assert not json.loads(registry.dispatch('project_run', {'command':'printf safe', 'secrets':['TEST_KEY']}, task_id=agent.session_id))['ok']
    broker.continue_session(agent, 'run-a', agent.session_id)
    assert not json.loads(registry.dispatch('project_run', {'command':'printf safe', 'secrets':['TEST_KEY']}, task_id='session-a'))['ok']
assert json.loads(registry.dispatch('project_run', {'command':'printf safe', 'secrets':['TEST_KEY']}, task_id=agent.session_id))['ok']
broker.cancel_run('run-a')
assert not json.loads(registry.dispatch('project_run', {'command':'printf safe', 'secrets':['TEST_KEY']}, task_id=agent.session_id))['ok']
db.close()
print('Native registry, compaction, MCP refresh and root-session isolation passed')
'''.replace('SOURCE', repr(os.environ['OLYMPUS_NATIVE_HERMES_SOURCE'])).replace(
    'WORKERS', repr(str(Path(__file__).resolve().parents[1] / 'server' / 'workers')))
        with tempfile.TemporaryDirectory(prefix='olympus-native-project-run-') as home:
            result = subprocess.run([sys.executable, '-c', script], text=True, capture_output=True,
                                    env={**os.environ, 'HERMES_HOME': home})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__': unittest.main()
