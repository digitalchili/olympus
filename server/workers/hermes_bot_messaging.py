"""Native message_agent interface with Olympus-owned durable delivery.

No CLI/gateway transport is called. A tool waits only for a bounded queue receipt;
recipient execution and reply delivery belong to the Olympus server.
"""
from __future__ import annotations

import copy
import importlib
import json
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable


class BotMessageError(RuntimeError):
    code = 'bot_messaging_unavailable'


def _error(message: str) -> str:
    return json.dumps({'accepted': False, 'error': message})


def _native_dispatch(target='', message='', task_id=None, agent=None) -> str:
    callback = getattr(agent, '_olympus_bot_send', None)
    if not callable(callback):
        return _error('message_agent is only available in an active Olympus Bot conversation.')
    try:
        return callback(target, message)
    except Exception:
        # Never delegate an error to native delivery: that spawns an unowned agent.
        return _error('Olympus could not acknowledge delivery. Do not retry automatically.')


_install_lock = threading.Lock()


def install_native_guard() -> bool:
    with _install_lock:
        try:
            native = importlib.import_module('tools.bot_mode_dm')
        except ImportError:
            return False
        native.message_agent_tool = _native_dispatch
        return callable(getattr(native, 'message_agent_tool_schema', None))


def _install_refresh_guard() -> None:
    with _install_lock:
        try:
            native = importlib.import_module('tools.mcp_tool')
        except ImportError as exc:
            raise BotMessageError('Installed Hermes does not expose the tool refresh hook') from exc
        original = getattr(native, '_reinject_post_build_tools', None)
        if not callable(original):
            raise BotMessageError('Installed Hermes does not expose the tool refresh hook')
        if getattr(original, '_olympus_bot_guard', False):
            return

        def reinject(agent, tools_list, name_set):
            engine_names = original(agent, tools_list, name_set)
            schema = getattr(agent, '_olympus_bot_schema', None)
            if (callable(getattr(agent, '_olympus_bot_send', None))
                    and isinstance(schema, dict) and 'message_agent' not in name_set):
                tools_list.append(copy.deepcopy(schema))
                name_set.add('message_agent')
            return engine_names

        # Stage before Hermes publishes its atomic snapshot. Both MCP refresh
        # and compaction use this hook; native Bot Mode must remain disabled.
        reinject._olympus_bot_guard = True
        native._reinject_post_build_tools = reinject


@dataclass
class _Run:
    task_id: str
    worker_run_id: str
    targets: frozenset[str]
    deadline: float
    agent: Any
    closed: bool = False


@dataclass
class _Pending:
    run: _Run
    deadline: float
    event: threading.Event = field(default_factory=threading.Event)
    result: dict | None = None


class BotMessageBroker:
    def __init__(self, send: Callable, *, timeout_seconds: float = 10):
        self._send = send
        self.timeout_seconds = timeout_seconds
        self._lock = threading.Lock()
        self._runs: dict[str, _Run] = {}
        self._pending: dict[str, _Pending] = {}

    def bind(self, agent, task_id: str, run_id: str, targets: frozenset[str], deadline: float):
        state = _Run(task_id, run_id, targets, deadline, agent)
        with self._lock:
            if run_id in self._runs:
                raise BotMessageError('Bot run already registered')
            self._runs[run_id] = state
        agent._olympus_bot_send = lambda target, message: self._request(state, target, message)

    def _request(self, run: _Run, target: Any, message: Any) -> str:
        if not isinstance(target, str) or target.strip().lstrip('@') not in run.targets:
            return _error('Choose another active local profile ID from the Bot roster.')
        target = target.strip().lstrip('@')
        # Match JavaScript string.length at the durable server boundary.
        if not isinstance(message, str) or not 1 <= len(message.strip().encode('utf-16-le', 'surrogatepass')) // 2 <= 12000:
            return _error('message must contain between 1 and 12000 characters.')
        request_id = uuid.uuid4().hex
        with self._lock:
            if run.closed or getattr(run.agent, '_interrupt_requested', False) or time.monotonic() >= run.deadline:
                return _error('The Bot run has stopped; no message was queued.')
            deadline = min(run.deadline, time.monotonic() + max(.001, min(10, self.timeout_seconds)))
            pending = _Pending(run, deadline)
            self._pending[request_id] = pending
        try:
            self._send({'id': run.worker_run_id, 'type': 'bot_message_requested', 'botMessage': {
                'requestId': request_id, 'workerRunId': run.worker_run_id,
                'target': target, 'message': message.strip(),
            }})
            pending.event.wait(max(0, deadline - time.monotonic()))
            with self._lock:
                if pending.result is not None and not run.closed and time.monotonic() < deadline:
                    return json.dumps(pending.result)
            return _error('Delivery acknowledgement expired or the Bot run stopped. Delivery may have been queued. Do not retry automatically.')
        finally:
            with self._lock:
                self._pending.pop(request_id, None)

    def respond(self, request: dict) -> dict:
        result = request.get('result')
        if not isinstance(result, dict) or not isinstance(result.get('accepted'), bool):
            raise BotMessageError('Invalid Bot delivery acknowledgement')
        if result['accepted']:
            receipt = result.get('messageId')
            if not isinstance(receipt, str) or not 1 <= len(receipt) <= 256:
                raise BotMessageError('A durable message receipt is required')
            result = {'accepted': True, 'messageId': receipt}
        else:
            error = result.get('error') or 'Olympus rejected this delivery.'
            if not isinstance(error, str) or len(error) > 2000:
                raise BotMessageError('Invalid Bot delivery error')
            result = {'accepted': False, 'error': error}
        with self._lock:
            pending = self._pending.get(request.get('requestId'))
            if (pending is None or pending.run.closed or pending.result is not None
                    or time.monotonic() >= pending.deadline
                    or pending.run.task_id != request.get('taskId')
                    or pending.run.worker_run_id != request.get('workerRunId')):
                raise BotMessageError('Bot delivery request is stale or belongs to another run')
            pending.result = result
            pending.event.set()
        return {'accepted': True}

    def cancel_run(self, run_id: str) -> None:
        with self._lock:
            run = self._runs.pop(run_id, None)
            if run is not None:
                run.closed = True
            for pending in self._pending.values():
                if pending.run.worker_run_id == run_id:
                    pending.event.set()


def configure_bot_agent(agent: Any, bot: dict, broker: BotMessageBroker,
                        task_id: str, run_id: str, deadline: float) -> None:
    valid_id = lambda value: isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', value)
    if not isinstance(bot, dict) or not valid_id(bot.get('profileId')) or not isinstance(bot.get('peers'), list):
        raise BotMessageError('Invalid Olympus Bot context')
    peers = bot['peers']
    if len(peers) > 100 or any(not isinstance(peer, dict) or not valid_id(peer.get('id')) for peer in peers):
        raise BotMessageError('Invalid Olympus Bot roster')
    if not install_native_guard():
        raise BotMessageError('Installed Hermes does not expose the native message_agent schema')
    schema = copy.deepcopy(importlib.import_module('tools.bot_mode_dm').message_agent_tool_schema())
    if not isinstance(schema, dict) or schema.get('function', {}).get('name') != 'message_agent':
        raise BotMessageError('Installed Hermes message_agent schema is incompatible')
    schema['function']['description'] = (
        'Send a message to another active local profile ID from your Olympus Bot roster. '
        'Compose only the information needed for the request; keep private chat content private. '
        'This returns a durable queue receipt, not the recipient reply. Finish your turn without '
        'polling; Olympus delivers replies later. Remote peers and self-messaging are unavailable. '
        'Never automatically retry an uncertain delivery.'
    )
    _install_refresh_guard()
    agent._olympus_bot_schema = copy.deepcopy(schema)
    agent.tools = [tool for tool in (agent.tools or []) if tool.get('function', {}).get('name') != 'message_agent'] + [schema]
    agent.valid_tool_names = set(getattr(agent, 'valid_tool_names', set())) | {'message_agent'}
    agent._bot_mode_protocol = False
    broker.bind(agent, task_id, run_id, frozenset(peer['id'] for peer in peers if peer['id'] != bot['profileId']), deadline)
