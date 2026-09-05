"""Human-input transport for Hermes callbacks; actions are never executed here.

The worker owns in-flight waiters. Olympus persists their immutable display
payloads and operator responses. Restart/timeout cancels the waiter; an old
approval can never authorize a new tool call. Native callback results are
returned only after a response bound to task, turn and interaction identity.
"""
from __future__ import annotations

import copy
from contextlib import contextmanager
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable


class InteractionError(RuntimeError):
    def __init__(self, message: str, code: str = "interaction_invalid"):
        super().__init__(message)
        self.code = code


def native_redact(text: str) -> str:
    from agent.redact import redact_sensitive_text
    return redact_sensitive_text(text, force=True, redact_url_credentials=True)


def _text(value: Any, maximum: int = 10000) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise InteractionError("Expected non-empty bounded text")
    return value


@dataclass
class _Pending:
    task_id: str
    run_id: str
    payload: dict[str, Any]
    deadline: float
    event: threading.Event = field(default_factory=threading.Event)
    response: dict[str, Any] | None = None
    status: str = "pending"


class InteractionBroker:
    def __init__(self, send: Callable, *, redact: Callable = native_redact):
        self._send = send
        self._redact = redact
        self._lock = threading.Lock()
        self._pending: dict[str, _Pending] = {}

    def _display(self, text: str) -> str:
        # Missing/failing redaction must never fall back to the raw target.
        try:
            value = self._redact(text)
            if not isinstance(value, str):
                raise ValueError("Invalid redaction result")
            return value
        except Exception as exc:
            raise InteractionError("Cannot safely display the interaction", "interaction_unavailable") from exc

    def _questions(self, question: str, choices, multi_select: bool, questions) -> list[dict]:
        raw = questions if questions is not None else [{"qid": "q1", "question": question, "choices": choices, "multi_select": multi_select}]
        if not isinstance(raw, list) or not 1 <= len(raw) <= 5:
            raise InteractionError("Provide between one and five questions")
        result = []
        identifiers: set[str] = set()
        for index, item in enumerate(raw):
            if not isinstance(item, dict):
                raise InteractionError("Question must be an object")
            qid = item.get("qid", f"q{index + 1}")
            _text(qid, 80)
            if qid in identifiers or qid in {"__proto__", "prototype", "constructor"}:
                raise InteractionError("Question identifiers must be unique and safe")
            identifiers.add(qid)
            text = _text(item.get("question"))
            options = item.get("choices") or []
            if not isinstance(options, list) or len(options) > 4:
                raise InteractionError("Questions support at most four choices")
            options = [self._display(_text(option, 2000)) for option in options]
            multi = item.get("multi_select", False)
            if not isinstance(multi, bool):
                raise InteractionError("multi_select must be a boolean")
            result.append({"id": qid, "question": self._display(text), "choices": options, "multiSelect": multi})
        return result

    def _wait(self, task_id: str, run_id: str, payload: dict, *, interrupt: Callable, timeout_seconds: float) -> dict:
        _text(task_id, 256)
        _text(run_id, 256)
        timeout_seconds = min(1800, max(0.001, timeout_seconds))
        identity = uuid.uuid4().hex
        payload = {**payload, "id": identity, "workerRunId": run_id, "expiresAt": int((time.time() + timeout_seconds) * 1000)}
        pending = _Pending(task_id, run_id, payload, time.monotonic() + timeout_seconds)
        with self._lock:
            if sum(item.run_id == run_id for item in self._pending.values()) >= 32:
                raise InteractionError("Too many pending questions", "interaction_unavailable")
            self._pending[identity] = pending
        try:
            self._send({"id": run_id, "type": "interaction_requested", "interaction": copy.deepcopy(payload)})
            pending.event.wait(timeout_seconds)
            with self._lock:
                if pending.status == "pending":
                    pending.status = "expired"
                status = pending.status
                response = copy.deepcopy(pending.response)
            self._send({"id": run_id, "type": "interaction_settled", "interactionId": identity, "status": status})
            if response is None or status not in {"answered", "denied"}:
                raise InteractionError("Input expired or was cancelled. Explicitly rerun the task to ask again.", "interaction_stale")
            return response
        except Exception:
            interrupt("Human input unavailable or expired; stopped without making assumptions or granting approval")
            raise
        finally:
            with self._lock:
                self._pending.pop(identity, None)

    def clarify(self, task_id: str, run_id: str, question: str = "", choices=None, multi_select: bool = False,
                *, questions=None, interrupt: Callable, timeout_seconds: float = 1800):
        try:
            normalized = self._questions(question, choices, multi_select, questions)
            title = self._display(question[:1000]) if question else "Your decision is needed"
            response = self._wait(task_id, run_id, {"kind": "clarification", "title": title, "questions": normalized},
                                  interrupt=interrupt, timeout_seconds=timeout_seconds)
        except InteractionError:
            interrupt("Clarification was not answered; stopped without making assumptions")
            raise
        if questions is not None:
            return {"answers": response["answers"]}
        answer = response["answers"][normalized[0]["id"]]
        # Native clarify accepts lists directly for multi-select callbacks.
        return answer

    def approve(self, task_id: str, run_id: str, command: str, description: str, *, interrupt: Callable,
                timeout_seconds: float = 1800, **_native_options) -> str:
        try:
            response = self._wait(task_id, run_id, {
                "kind": "approval", "title": "Approval required", "questions": [],
                "command": self._display(_text(command, 50000)),
                "reason": self._display(_text(description, 10000)),
            }, interrupt=interrupt, timeout_seconds=timeout_seconds)
            return response["decision"]
        except Exception:
            interrupt("Approval unavailable or expired; action denied")
            # Hermes' approval callback boundary converts exceptions to denial.
            raise

    def respond(self, request: dict) -> dict:
        with self._lock:
            identity = request.get("interactionId")
            pending = self._pending.get(identity) if isinstance(identity, str) else None
            if (pending is None or pending.status != "pending"
                    or pending.task_id != request.get("taskId") or pending.run_id != request.get("workerRunId")):
                raise InteractionError("Interaction is no longer waiting in this task and turn", "interaction_stale")
            if time.monotonic() >= pending.deadline:
                pending.status = "expired"
                pending.event.set()
                raise InteractionError("Interaction expired", "interaction_stale")
            response = request.get("response")
            if not isinstance(response, dict):
                raise InteractionError("Response must be an object")
            if pending.payload["kind"] == "approval":
                if set(response) != {"decision"} or response["decision"] not in ("once", "deny"):
                    raise InteractionError("Only approve once or deny is allowed")
                status = "answered" if response["decision"] == "once" else "denied"
            else:
                questions = pending.payload["questions"]
                answers = response.get("answers")
                if (set(response) != {"answers"} or not isinstance(answers, dict)
                        or set(answers) != {q["id"] for q in questions}):
                    raise InteractionError("Every question must be answered exactly once")
                for question in questions:
                    value = answers[question["id"]]
                    if question["multiSelect"]:
                        if not isinstance(value, list) or not 1 <= len(value) <= 5:
                            raise InteractionError("Multi-select requires one to five answers")
                        for option in value:
                            _text(option)
                        if len(set(value)) != len(value):
                            raise InteractionError("Multi-select answers must be unique")
                    else:
                        _text(value)
                status = "answered"
            pending.response = copy.deepcopy(response)
            pending.status = status
            pending.event.set()
        return {"accepted": True}

    def cancel_run(self, run_id: str) -> None:
        with self._lock:
            for pending in self._pending.values():
                if pending.run_id == run_id and pending.status == "pending":
                    pending.status = "cancelled"
                    pending.event.set()


def _supports_native_approval_context() -> bool:
    try:
        from tools import approval, terminal_tool
    except ImportError:
        return False
    required = ("set_hermes_interactive_context", "reset_hermes_interactive_context", "set_current_session_key", "reset_current_session_key")
    return (all(callable(getattr(approval, name, None)) for name in required)
            and callable(getattr(terminal_tool, "_get_approval_callback", None))
            and callable(getattr(terminal_tool, "set_approval_callback", None)))


def interaction_disabled_toolsets() -> list[str]:
    # computer_use still uses a process-global, fail-open callback in Hermes
    # 0.21. Never share it across concurrent task sessions. Ordinary chat works
    # on older runtimes, but terminal stays off until its scoped gate exists.
    return ["computer_use"] + ([] if _supports_native_approval_context() else ["terminal"])


@contextmanager
def native_approval_context(callback: Callable, session_id: str):
    """Bind approval identity/UI to this turn, not process-global CLI flags.

    Hermes propagates its thread-local terminal callback into concurrent tool
    and delegation threads. Cron and other profile sessions retain their own
    approval context. Existing profile policy is read, never rewritten here.
    """
    if not _supports_native_approval_context():
        # _create_agent excludes tools whose approval gates cannot be hosted.
        yield
        return
    from tools import approval, terminal_tool
    previous = terminal_tool._get_approval_callback()
    interactive_token = approval.set_hermes_interactive_context(True)
    session_token = approval.set_current_session_key(session_id)
    terminal_tool.set_approval_callback(callback)
    try:
        yield
    finally:
        terminal_tool.set_approval_callback(previous)
        approval.reset_current_session_key(session_token)
        approval.reset_hermes_interactive_context(interactive_token)


def approval_preflight(command: Any, env_type: str = "local") -> dict:
    """Native read-only evaluator: no execution, prompt or approval persistence."""
    command = _text(command, 50000)
    try:
        from hermes_cli.approvals_test import evaluate_command
        result = evaluate_command(command, env_type=env_type)
        verdict = {"allow": "allow", "ask-approval": "ask", "hardline-deny": "deny", "user-deny": "deny"}.get(result.get("verdict"), "unsupported")
        return {"verdict": verdict, "command": native_redact(command), "reason": native_redact(str(result.get("detail") or result.get("rule") or "No explanation available"))}
    except Exception:
        return {"verdict": "unsupported", "command": "", "reason": "Native read-only approval preflight is unavailable in this Hermes runtime."}
