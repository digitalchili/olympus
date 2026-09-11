"""Project repository bridge: trusted runtime identity, revocation and native refresh."""
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
import hermes_project_github as github


class ProjectGitHubTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.ready = threading.Event()
        def send(event):
            self.events.append(event)
            self.ready.set()
        self.broker = github.ProjectGitHubBroker(send)
        self.pool = ThreadPoolExecutor(max_workers=3)
        self.registry = ModuleType('tools.registry')
        self.registry.registry = SimpleNamespace(register=Mock())
        self.mcp = ModuleType('tools.mcp_tool')
        self.mcp._reinject_post_build_tools = lambda agent, tools, names: {'native'}
        self.modules = patch.dict(sys.modules, {'tools': ModuleType('tools'),
            'tools.registry': self.registry, 'tools.mcp_tool': self.mcp})
        self.modules.start()
        self.agent = self.configure('task-a', 'run-a', 'session-a')
        self.handler = self.registry.registry.register.call_args.kwargs['handler']

    def configure(self, task, run, session):
        agent = SimpleNamespace(tools=[], valid_tool_names=set(), _interrupt_requested=False)
        github.configure_project_github_agent(agent, self.broker, task, run, session)
        return agent

    def tearDown(self):
        for run in ('run-a', 'run-b'):
            self.broker.cancel_run(run)
        self.pool.shutdown(wait=True)
        self.modules.stop()

    def begin(self, session='session-a', action='list', repository=None):
        self.ready.clear()
        args = {'action': action}
        if repository is not None: args['repository'] = repository
        future = self.pool.submit(self.handler, args, task_id=session)
        self.assertTrue(self.ready.wait(2))
        return future, self.events[-1]['projectGitHub']

    def respond(self, request, **changes):
        return self.broker.respond({'taskId': 'task-a', **request,
                                   'result': {'ok': True, 'repositories': []}, **changes})

    def test_registered_schema_and_runtime_session_request(self):
        self.assertIn('project_github', self.agent.valid_tool_names)
        self.assertEqual(set(self.agent.tools[0]['function']['parameters']['properties']), {'action', 'repository'})
        future, request = self.begin(action='check', repository='owner/repo')
        self.assertFalse(future.done())
        self.assertEqual(request['workerRunId'], 'run-a')
        self.assertEqual(request['action'], 'check')
        self.assertEqual(request['repository'], 'owner/repo')
        self.assertEqual(self.events[0]['id'], 'run-a')
        self.respond(request)
        self.assertTrue(json.loads(future.result(1))['ok'])

    def test_other_task_run_and_stale_response_rejected(self):
        future, request = self.begin()
        for changes in ({'taskId': 'other'}, {'workerRunId': 'run-b'}, {'requestId': 'other'}, {'result': []}):
            with self.assertRaises(github.ProjectGitHubError): self.respond(request, **changes)
        self.assertFalse(future.done())
        self.respond(request)
        future.result(1)
        with self.assertRaises(github.ProjectGitHubError): self.respond(request)

    def test_missing_grant_and_child_sessions_cannot_borrow_root_authority(self):
        for session in (None, '', 'task-a', 'session-child', 'unrelated'):
            self.assertFalse(json.loads(self.handler({'action': 'list'}, task_id=session))['ok'])
        for args in ({'action': 'push'}, {'action': 'clone'}, {'action': 'clone', 'repository': '../x'},
                     {'action': 'list', 'task_id': 'session-a'}):
            self.assertFalse(json.loads(self.handler(args, task_id='session-a'))['ok'])
        self.assertEqual(self.events, [])

    def test_two_active_sessions_keep_independent_identity(self):
        self.configure('task-b', 'run-b', 'session-b')
        first, req1 = self.begin()
        second, req2 = self.begin(session='session-b')
        self.respond(req2, taskId='task-b')
        self.assertTrue(json.loads(second.result(1))['ok'])
        self.assertFalse(first.done())
        self.respond(req1)
        first.result(1)

    def test_cancel_releases_indefinite_wait_and_rejects_late_calls(self):
        future, request = self.begin()
        self.broker.cancel_run('run-a')
        self.assertFalse(json.loads(future.result(1))['ok'])
        with self.assertRaises(github.ProjectGitHubError): self.respond(request)
        self.assertFalse(json.loads(self.handler({'action': 'list'}, task_id='session-a'))['ok'])
        self.assertEqual(len(self.events), 1)

    def test_refresh_isolation_and_closed_run_removes_schema(self):
        for agent, allowed in ((self.agent, True), (SimpleNamespace(), False)):
            tools = [{'type': 'function', 'function': {'name': 'project_github'}}]
            names = {'project_github'}
            native = self.mcp._reinject_post_build_tools(agent, tools, names)
            self.assertEqual(native, {'native'})
            self.assertEqual('project_github' in names, allowed)
            self.assertEqual(len(tools), int(allowed))
        self.broker.cancel_run('run-a')
        tools, names = [], set()
        self.mcp._reinject_post_build_tools(self.agent, tools, names)
        self.assertEqual(tools, [])

    def test_missing_refresh_hook_fails_closed(self):
        del self.mcp._reinject_post_build_tools
        with self.assertRaisesRegex(github.ProjectGitHubError, 'refresh hook'):
            self.configure('task-b', 'run-b', 'session-b')
        self.assertFalse(json.loads(self.handler({'action': 'list'}, task_id='session-b'))['ok'])

    def test_fixed_schema_native_does_not_require_refresh_hook(self):
        del self.mcp._reinject_post_build_tools
        compression = ModuleType('agent.conversation_compression')
        compression.compress_context = lambda: None
        with patch.dict(sys.modules, {'agent.conversation_compression': compression}):
            agent = self.configure('task-b', 'run-b', 'session-b')
        self.assertIn('project_github', agent.valid_tool_names)

    def test_rebuilding_native_without_hook_fails_closed(self):
        del self.mcp._reinject_post_build_tools
        compression = ModuleType('agent.conversation_compression')
        compression.compress_context = lambda: None
        compression._refresh_agent_tool_definitions = lambda: None
        with patch.dict(sys.modules, {'agent.conversation_compression': compression}):
            with self.assertRaises(github.ProjectGitHubError):
                self.configure('task-b', 'run-b', 'session-b')

    def test_result_metadata_allowlist_discards_credential_fields(self):
        future, request = self.begin()
        self.respond(request, result={'ok': True, 'token': 'never-return', 'authorization': 'never-return',
            'repositories': [{'fullName': 'owner/repo', 'defaultBranch': 'main', 'private': True,
                              'installationId': 42, 'token': 'never-return'}]})
        result = json.loads(future.result(1))
        self.assertEqual(result, {'ok': True, 'repositories': [{'fullName': 'owner/repo',
            'defaultBranch': 'main', 'private': True, 'installationId': 42}]})

    def test_duplicate_active_root_session_rejected(self):
        with self.assertRaises(github.ProjectGitHubError):
            self.configure('task-b', 'run-b', 'session-a')

    def test_continuation_rebind_requires_same_agent_and_current_native_session(self):
        self.agent.session_id = 'session-compacted'
        with self.assertRaises(github.ProjectGitHubError):
            self.broker.continue_session(SimpleNamespace(session_id='session-compacted'), 'run-a', 'session-compacted')
        with self.assertRaises(github.ProjectGitHubError):
            self.broker.continue_session(self.agent, 'run-a', 'arbitrary-child')
        self.broker.continue_session(self.agent, 'run-a', 'session-compacted')
        self.assertFalse(json.loads(self.handler({'action': 'list'}, task_id='session-a'))['ok'])
        self.assertFalse(json.loads(self.handler({'action': 'list'}, task_id='arbitrary-child'))['ok'])
        future, request = self.begin(session='session-compacted')
        self.respond(request)
        self.assertTrue(json.loads(future.result(1))['ok'])
        self.broker.cancel_run('run-a')
        with self.assertRaises(github.ProjectGitHubError):
            self.broker.continue_session(self.agent, 'run-a', 'session-compacted')
        self.assertFalse(json.loads(self.handler({'action': 'list'}, task_id='session-compacted'))['ok'])

    def test_continuation_cannot_take_another_registered_session(self):
        self.configure('task-b', 'run-b', 'session-b')
        self.agent.session_id = 'session-b'
        with self.assertRaises(github.ProjectGitHubError):
            self.broker.continue_session(self.agent, 'run-a', 'session-b')

    def test_worker_interaction_interrupt_releases_pending_tool(self):
        import hermes_worker as worker
        self.agent.interrupt = Mock()
        future, _ = self.begin()
        with patch.object(worker, 'PROJECT_GITHUB', self.broker):
            self.assertTrue(worker._try_interrupt_agent(self.agent, 'Approval denied'))
        self.assertFalse(json.loads(future.result(.1))['ok'])

    def test_worker_rpc_stop_and_terminal_cleanup(self):
        import hermes_worker as worker
        future, request = self.begin()
        with patch.object(worker, 'PROJECT_GITHUB', self.broker), patch.object(worker, '_result'):
            worker._handle_request({'id': 'ack', 'type': 'project.github.respond', 'taskId': 'task-a',
                                    **request, 'result': {'ok': True, 'repositories': []}})
        self.assertTrue(json.loads(future.result(1))['ok'])
        future, _ = self.begin()
        with patch.object(worker, 'PROJECT_GITHUB', self.broker), patch.object(worker, 'ACTIVE_TASKS', {'task-a': 'run-a'}), \
                patch.object(worker, 'ACTIVE_AGENTS', {'task-a': self.agent}), patch.object(worker, 'ContinuationJournal'), \
                patch.object(worker, '_try_interrupt_agent', return_value=True):
            self.assertTrue(worker._interrupt_active_chat({'taskId': 'task-a'})['interrupted'])
        self.assertFalse(json.loads(future.result(1))['ok'])
        self.agent = self.configure('task-a', 'run-a', 'session-a')
        future, _ = self.begin()
        def terminal(event):
            self.assertFalse(json.loads(self.handler({'action': 'list'}, task_id='session-a'))['ok'])
        with patch.object(worker, 'PROJECT_GITHUB', self.broker), patch.object(worker, '_clear_task_active'), \
                patch.object(worker, '_run_chat', return_value=[{'id': 'run-a', 'type': 'done'}]), \
                patch.object(worker, '_send', side_effect=terminal):
            worker._run_chat_thread('run-a', {}, 'task-a')
        self.assertFalse(json.loads(future.result(1))['ok'])



@unittest.skipUnless(os.environ.get('OLYMPUS_NATIVE_HERMES_SOURCE'), 'native Hermes source not selected')
class NativeProjectGitHubTests(unittest.TestCase):
    def test_native_registry_compaction_and_mcp_refresh_preserve_authority(self):
        script = r'''
import asyncio, json, sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
sys.path.insert(0, SOURCE)
sys.path.insert(0, WORKERS)
from hermes_project_github import ProjectGitHubBroker, configure_project_github_agent
from tools.registry import registry
from tools import mcp_tool
from agent import conversation_compression as compression
from hermes_state import SessionDB

db = SessionDB()
db.create_session(session_id='session-a', source='test', model='native-test')
agent = SimpleNamespace(tools=[], valid_tool_names=set(), _interrupt_requested=False,
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
    broker.respond({'taskId':'task-a', **event['projectGitHub'], 'result': {'ok': True, 'branches': ['main']}})
broker=ProjectGitHubBroker(send)
configure_project_github_agent(agent, broker, 'task-a', 'run-a', 'session-a')
assert registry.get_definitions({'project_github'}, quiet=True) == [], 'global schema leaked to unrelated agents'
for session in ('session-a', 'child-session', None):
    result=json.loads(registry.dispatch('project_github', {'action':'check', 'repository':'owner/repo'}, task_id=session))
    assert result['ok'] is (session == 'session-a')
assert len(events)==1

if hasattr(mcp_tool, 'refresh_agent_mcp_tools'):
    with patch('model_tools.get_tool_definitions', return_value=[]):
        mcp_tool.refresh_agent_mcp_tools(agent)
        compression._refresh_agent_tool_definitions(agent)
    assert 'project_github' in agent.valid_tool_names
else:
    # The installed fixed-schema version runs real compaction bookkeeping,
    # with only the summarizer and file-read cache replaced (no provider call).
    old_tools = agent.tools
    with patch('tools.file_tools.reset_file_dedup'):
        compressed, _ = compression.compress_context(agent, [{'role':'user','content':'original'}], 'system', task_id='session-a')
    assert compressed[0]['content']=='summary'
    assert agent.tools is old_tools and 'project_github' in agent.valid_tool_names
    # Invoke the installed MCP registry-refresh method with an empty local
    # response; no MCP server, network, profile or credential access occurs.
    cls = next(value for value in vars(mcp_tool).values() if isinstance(value,type) and hasattr(value,'_refresh_tools'))
    server = SimpleNamespace(_refresh_lock=asyncio.Lock(), _rpc_lock=asyncio.Lock(),
        _registered_tool_names=set(), name='native-test', _config={},
        session=SimpleNamespace(list_tools=AsyncMock(return_value=SimpleNamespace(tools=[]))))
    with patch.object(mcp_tool, '_register_server_tools', return_value=set()):
        asyncio.run(cls._refresh_tools(server))
    assert agent.tools is old_tools and 'project_github' in agent.valid_tool_names

if not hasattr(mcp_tool, 'refresh_agent_mcp_tools'):
    assert agent.session_id != 'session-a', 'real SessionDB compaction did not rotate session'
    assert db.get_session(agent.session_id)['parent_session_id'] == 'session-a'
    assert not json.loads(registry.dispatch('project_github', {'action':'list'}, task_id=agent.session_id))['ok']
    broker.continue_session(agent, 'run-a', agent.session_id)
    assert not json.loads(registry.dispatch('project_github', {'action':'list'}, task_id='session-a'))['ok']
assert json.loads(registry.dispatch('project_github', {'action':'list'}, task_id=agent.session_id))['ok']
broker.cancel_run('run-a')
assert not json.loads(registry.dispatch('project_github', {'action':'list'}, task_id=agent.session_id))['ok']
db.close()
print('Native registry, compaction, MCP refresh and root-session isolation passed')
'''.replace('SOURCE', repr(os.environ['OLYMPUS_NATIVE_HERMES_SOURCE'])).replace(
    'WORKERS', repr(str(Path(__file__).resolve().parents[1] / 'server' / 'workers')))
        with tempfile.TemporaryDirectory(prefix='olympus-native-project-github-') as home:
            result = subprocess.run([sys.executable, '-c', script], text=True, capture_output=True,
                                    env={**os.environ, 'HERMES_HOME': home})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__': unittest.main()
