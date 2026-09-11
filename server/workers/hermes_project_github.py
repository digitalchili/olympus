"""Project source access through a task-bound Olympus server broker.

Hermes owns tool execution; Olympus owns grants, GitHub credentials and clones.
Only the runtime root session registered for this run may request an operation.
"""
from __future__ import annotations

import copy
import importlib
import json
import re
import threading
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable


class ProjectGitHubError(RuntimeError):
    code = 'project_github_unavailable'


SCHEMA = {'name': 'project_github', 'description': (
    'Read repositories from the GitHub accounts selected for this Project. '
    'Use list to discover accessible repositories, check to verify a repository and branches, '
    'or clone to obtain a local full-history source checkout. Repository is owner/name. '
    'Source access is read-only; publishing uses the Project primary repository. '
    'Account selection is not proof of a successful check or clone.'
), 'parameters': {'type': 'object', 'properties': {
    'action': {'type': 'string', 'enum': ['list', 'check', 'clone']},
    'repository': {'type': 'string', 'description': 'Repository in owner/name form for check or clone.'},
}, 'required': ['action'], 'additionalProperties': False}}


def _error(message: str) -> str:
    return json.dumps({'ok': False, 'error': message})


_install_lock = threading.Lock()


def _install_refresh_guard() -> None:
    with _install_lock:
        try:
            native = importlib.import_module('tools.mcp_tool')
            original = getattr(native, '_reinject_post_build_tools', None)
            if not callable(original):
                compression = importlib.import_module('agent.conversation_compression')
                # Older Hermes keeps the initial agent.tools snapshot through
                # compaction and updates only the global registry for MCP.
                if (callable(getattr(compression, 'compress_context', None))
                        and not hasattr(compression, '_refresh_agent_tool_definitions')
                        and not hasattr(native, 'refresh_agent_mcp_tools')):
                    return
                raise ProjectGitHubError('Installed Hermes does not expose the tool refresh hook')
        except ImportError as exc:
            raise ProjectGitHubError('Installed Hermes does not expose the tool refresh hook') from exc
        if getattr(original, '_olympus_project_github_guard', False):
            return

        def reinject(agent, tools_list, name_set):
            engine_names = original(agent, tools_list, name_set)
            # Never retain a process-wide registry definition in an unrelated
            # agent snapshot, even if a native rebuild selected every toolset.
            tools_list[:] = [tool for tool in tools_list if tool.get('function', {}).get('name') != 'project_github']
            name_set.discard('project_github')
            run = getattr(agent, '_olympus_project_github_run', None)
            if isinstance(run, _Run) and run.agent is agent and not run.closed:
                tools_list.append({'type': 'function', 'function': copy.deepcopy(SCHEMA)})
                name_set.add('project_github')
            return engine_names

        reinject._olympus_project_github_guard = True
        native._reinject_post_build_tools = reinject


@dataclass
class _Run:
    task_id: str
    worker_run_id: str
    session_id: str
    agent: Any
    closed: bool = False


@dataclass
class _Pending:
    run: _Run
    event: threading.Event = field(default_factory=threading.Event)
    result: dict | None = None


def _safe_result(result: Any) -> dict:
    if not isinstance(result, dict) or not isinstance(result.get('ok'), bool):
        raise ProjectGitHubError('Invalid Project GitHub result')
    if not result['ok']:
        error = result.get('error')
        if not isinstance(error, str) or not 1 <= len(error) <= 2000:
            raise ProjectGitHubError('Invalid Project GitHub error')
        return {'ok': False, 'error': error}
    # Server responses carry metadata only. Unknown fields (including any
    # credential field) never enter Hermes history or the model context.
    safe = {'ok': True}
    for key in ('repository', 'defaultBranch', 'path'):
        if isinstance(result.get(key), str): safe[key] = result[key]
    if isinstance(result.get('existing'), bool): safe['existing'] = result['existing']
    if isinstance(result.get('branches'), list):
        safe['branches'] = [branch for branch in result['branches'] if isinstance(branch, str)]
    if isinstance(result.get('repositories'), list):
        safe['repositories'] = [{key: row[key] for key, expected in (
            ('fullName', str), ('defaultBranch', str), ('private', bool), ('installationId', int)
        ) if isinstance(row.get(key), expected)} for row in result['repositories'] if isinstance(row, dict)]
    return safe


class ProjectGitHubBroker:
    def __init__(self, send: Callable):
        self._send = send
        self._lock = threading.Lock()
        self._runs: dict[str, _Run] = {}
        self._sessions: dict[str, _Run] = {}
        self._pending: dict[str, _Pending] = {}

    def bind(self, agent: Any, task_id: str, run_id: str, session_id: str) -> None:
        if not all(isinstance(value, str) and value for value in (task_id, run_id, session_id)):
            raise ProjectGitHubError('Project GitHub requires a task and runtime session')
        with self._lock:
            if run_id in self._runs or session_id in self._sessions:
                raise ProjectGitHubError('Project GitHub run or session already registered')
            run = _Run(task_id, run_id, session_id, agent)
            self._runs[run_id] = self._sessions[session_id] = run
            agent._olympus_project_github_run = run

    def continue_session(self, agent: Any, run_id: str, session_id: str) -> None:
        """Move the runtime binding after the same root agent rotates its session."""
        with self._lock:
            run = self._runs.get(run_id)
            owner = self._sessions.get(session_id)
            if (run is None or run.closed or run.agent is not agent
                    or not isinstance(session_id, str) or not session_id
                    or session_id != getattr(agent, 'session_id', None)
                    or (owner is not None and owner is not run)):
                raise ProjectGitHubError('Project GitHub continuation does not belong to the active root agent')
            self._sessions.pop(run.session_id, None)
            run.session_id = session_id
            self._sessions[session_id] = run

    def dispatch(self, args: dict, **runtime) -> str:
        if (not isinstance(args, dict) or set(args) - {'action', 'repository'}
                or args.get('action') not in ('list', 'check', 'clone')):
            return _error('Choose list, check or clone using only action and repository.')
        repository = args.get('repository')
        if (args['action'] != 'list' or repository is not None) and (
                not isinstance(repository, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository)
                or any(part in ('.', '..') for part in repository.split('/'))):
            return _error('Specify a repository in owner/name form.')
        request_id = uuid.uuid4().hex
        with self._lock:
            run = self._sessions.get(runtime.get('task_id'))
            if run is None or run.closed or getattr(run.agent, '_interrupt_requested', False):
                return _error('Project GitHub access is unavailable for this runtime session.')
            pending = _Pending(run)
            self._pending[request_id] = pending
        try:
            request = {'requestId': request_id, 'workerRunId': run.worker_run_id, 'action': args['action']}
            if repository is not None: request['repository'] = repository
            self._send({'id': run.worker_run_id, 'type': 'project_github_requested', 'projectGitHub': request})
            # No agent/runtime time limit. Explicit Stop or terminal cleanup
            # cancels the run and releases every pending operation.
            pending.event.wait()
            with self._lock:
                if pending.result is not None and not run.closed:
                    return json.dumps(pending.result)
            return _error('The Project run stopped before repository access completed.')
        except Exception:
            return _error('Olympus could not complete Project repository access.')
        finally:
            with self._lock:
                self._pending.pop(request_id, None)

    def respond(self, request: dict) -> dict:
        result = _safe_result(request.get('result'))
        with self._lock:
            pending = self._pending.get(request.get('requestId'))
            if (pending is None or pending.run.closed or pending.result is not None
                    or pending.run.task_id != request.get('taskId')
                    or pending.run.worker_run_id != request.get('workerRunId')):
                raise ProjectGitHubError('Project GitHub request is stale or belongs to another run')
            pending.result = result
            pending.event.set()
        return {'accepted': True}

    def cancel_run(self, run_id: str) -> None:
        with self._lock:
            run = self._runs.pop(run_id, None)
            if run is not None:
                run.closed = True
                self._sessions.pop(run.session_id, None)
            for pending in self._pending.values():
                if pending.run.worker_run_id == run_id: pending.event.set()


def configure_project_github_agent(agent: Any, broker: ProjectGitHubBroker,
                                  task_id: str, run_id: str, session_id: str) -> None:
    _install_refresh_guard()
    try:
        registry = importlib.import_module('tools.registry').registry
        registry.register(name='project_github', toolset='olympus-project-github', schema=copy.deepcopy(SCHEMA),
                          handler=broker.dispatch, check_fn=lambda: False)
    except (ImportError, AttributeError) as exc:
        raise ProjectGitHubError('Installed Hermes does not expose native tool registration') from exc
    # check_fn excludes the global schema from ordinary discovery. Only this
    # explicitly granted agent receives a schema; dispatch checks its session.
    broker.bind(agent, task_id, run_id, session_id)
    agent.tools = [tool for tool in (agent.tools or []) if tool.get('function', {}).get('name') != 'project_github'] + [
        {'type': 'function', 'function': copy.deepcopy(SCHEMA)}]
    agent.valid_tool_names = set(getattr(agent, 'valid_tool_names', set())) | {'project_github'}
