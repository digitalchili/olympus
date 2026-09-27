"""Task-bound local commands: the server injects credentials, never the model.

Only a registered root run can request execution. Native command approvals remain
in force; the server returns sanitized output without credential values.
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


class ProjectRunError(RuntimeError):
    code = 'project_run_unavailable'


SCHEMA = {'name': 'project_run', 'description': (
    'Run a foreground local test command in this task workspace with selected saved Project secrets. '
    'Supply environment variable names only; Olympus supplies values privately to the child process. '
    'Use environment references in commands. Do not print, transform, persist or transmit credentials '
    'except to the service being tested. Do not start background servers or daemons.'
), 'parameters': {'type': 'object', 'properties': {
    'command': {'type': 'string', 'description': 'Foreground shell command; uses the task workspace.'},
    'secrets': {'type': 'array', 'items': {'type': 'string'}, 'minItems': 1, 'maxItems': 64,
                'description': 'Saved Project environment variable names required by this command.'},
}, 'required': ['command', 'secrets'], 'additionalProperties': False}}


def _approve_command(command: str) -> bool:
    from hermes_interactions import _supports_native_approval_context
    if not _supports_native_approval_context():
        return False
    from tools.terminal_tool import _check_all_guards, _foreground_background_guidance
    if _foreground_background_guidance(command):
        return False
    # This runs inside the same native_approval_context as ordinary terminal calls.
    return _check_all_guards(command, 'local', has_host_access=True).get('approved') is True


def _error(message: str) -> str:
    return json.dumps({'ok': False, 'error': message})


_install_lock = threading.Lock()


def _install_refresh_guard() -> None:
    with _install_lock:
        try:
            # Patch the implementation owner; the old facade no longer exports
            # this hook in Hermes v2026.9.24.
            try:
                native = importlib.import_module('tools.mcp_tool_agent')
            except ImportError:
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
                raise ProjectRunError('Installed Hermes does not expose the tool refresh hook')
        except ImportError as exc:
            raise ProjectRunError('Installed Hermes does not expose the tool refresh hook') from exc
        if getattr(original, '_olympus_project_run_guard', False):
            return

        def reinject(agent, tools_list, name_set):
            engine_names = original(agent, tools_list, name_set)
            # Never retain a process-wide registry definition in an unrelated
            # agent snapshot, even if a native rebuild selected every toolset.
            tools_list[:] = [tool for tool in tools_list if tool.get('function', {}).get('name') != 'project_run']
            name_set.discard('project_run')
            run = getattr(agent, '_olympus_project_run', None)
            if isinstance(run, _Run) and run.agent is agent and not run.closed:
                tools_list.append({'type': 'function', 'function': copy.deepcopy(SCHEMA)})
                name_set.add('project_run')
            return engine_names

        reinject._olympus_project_run_guard = True
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
        raise ProjectRunError('Invalid Project command result')
    if not result['ok']:
        # Error details cannot be supplied as a covert credential response.
        return {'ok': False, 'error': 'Project command unavailable. Check saved secrets, access and task status.'}
    if (type(result.get('exitCode')) is not int or not isinstance(result.get('output'), str)
            or len(result['output']) > 512_000 or not isinstance(result.get('truncated'), bool)):
        raise ProjectRunError('Invalid Project command result')
    return {key: result[key] for key in ('ok', 'exitCode', 'output', 'truncated')}


class ProjectRunBroker:
    def __init__(self, send: Callable):
        self._send = send
        self._lock = threading.Lock()
        self._runs: dict[str, _Run] = {}
        self._sessions: dict[str, _Run] = {}
        self._pending: dict[str, _Pending] = {}

    def bind(self, agent: Any, task_id: str, run_id: str, session_id: str) -> None:
        if not all(isinstance(value, str) and value for value in (task_id, run_id, session_id)):
            raise ProjectRunError('Project command requires a task and runtime session')
        with self._lock:
            if run_id in self._runs or session_id in self._sessions:
                raise ProjectRunError('Project command run or session already registered')
            run = _Run(task_id, run_id, session_id, agent)
            self._runs[run_id] = self._sessions[session_id] = run
            agent._olympus_project_run = run

    def continue_session(self, agent: Any, run_id: str, session_id: str) -> None:
        """Move the runtime binding after the same root agent rotates its session."""
        with self._lock:
            run = self._runs.get(run_id)
            owner = self._sessions.get(session_id)
            if (run is None or run.closed or run.agent is not agent
                    or not isinstance(session_id, str) or not session_id
                    or session_id != getattr(agent, 'session_id', None)
                    or (owner is not None and owner is not run)):
                raise ProjectRunError('Project command continuation does not belong to the active root agent')
            self._sessions.pop(run.session_id, None)
            run.session_id = session_id
            self._sessions[session_id] = run

    def dispatch(self, args: dict, **runtime) -> str:
        if (not isinstance(args, dict) or set(args) != {'command', 'secrets'}
                or not isinstance(args.get('command'), str) or not args['command'].strip()
                or len(args['command']) > 20_000 or '\x00' in args['command']
                or not isinstance(args.get('secrets'), list) or not 1 <= len(args['secrets']) <= 64
                or any(not isinstance(name, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}', name)
                       for name in args['secrets']) or len(set(args['secrets'])) != len(args['secrets'])):
            return _error('Supply a foreground command and unique saved secret names only.')
        with self._lock:
            run = self._sessions.get(runtime.get('task_id'))
            if run is None or run.closed or getattr(run.agent, '_interrupt_requested', False):
                return _error('Project commands are unavailable for this runtime session.')
        try:
            if not _approve_command(args['command']):
                return _error('The local command was not approved. Use the normal approval flow and a foreground command.')
        except Exception:
            return _error('Native command approval is unavailable; no command was run.')
        request_id = uuid.uuid4().hex
        with self._lock:
            run = self._sessions.get(runtime.get('task_id'))
            if run is None or run.closed or getattr(run.agent, '_interrupt_requested', False):
                return _error('Project command access is unavailable for this runtime session.')
            pending = _Pending(run)
            self._pending[request_id] = pending
        try:
            request = {'requestId': request_id, 'workerRunId': run.worker_run_id,
                       'command': args['command'], 'secrets': list(args['secrets'])}
            self._send({'id': run.worker_run_id, 'type': 'project_run_requested', 'projectRun': request})
            # No agent/runtime time limit. Explicit Stop or terminal cleanup
            # cancels the run and releases every pending operation.
            pending.event.wait()
            with self._lock:
                if pending.result is not None and not run.closed:
                    return json.dumps(pending.result)
            return _error('The Project run stopped before command execution completed.')
        except Exception:
            return _error('Olympus could not complete Project command.')
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
                raise ProjectRunError('Project command request is stale or belongs to another run')
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


def configure_project_run_agent(agent: Any, broker: ProjectRunBroker,
                                task_id: str, run_id: str, session_id: str) -> None:
    # A Project credential grant must not bypass a profile that disabled commands.
    if 'terminal' not in set(getattr(agent, 'valid_tool_names', set())):
        return
    _install_refresh_guard()
    try:
        registry = importlib.import_module('tools.registry').registry
        registry.register(name='project_run', toolset='olympus-project-run', schema=copy.deepcopy(SCHEMA),
                          handler=broker.dispatch, check_fn=lambda: False)
    except (ImportError, AttributeError) as exc:
        raise ProjectRunError('Installed Hermes does not expose native tool registration') from exc
    # check_fn excludes the global schema from ordinary discovery. Only this
    # explicitly granted agent receives a schema; dispatch checks its session.
    broker.bind(agent, task_id, run_id, session_id)
    agent.tools = [tool for tool in (agent.tools or []) if tool.get('function', {}).get('name') != 'project_run'] + [
        {'type': 'function', 'function': copy.deepcopy(SCHEMA)}]
    agent.valid_tool_names = set(getattr(agent, 'valid_tool_names', set())) | {'project_run'}
