"""Per-command tracing — model token usage, repair attempts, and the AppleScript each command ran.

Anthropic calls happen deep inside the command path (script generation, repair,
project generation), while the audit record is written at the top in
`_execute_command`. Rather than threading a trace argument through every
function, each command opens a context-local accumulator that nested code
writes into. The span also carries the command's `command_id` and `client_id`,
so the same hooks publish live events (model_call, script, repair) that the
phone can match to the command.

`contextvars` is the right primitive here: `_execute_command` runs each command
on the command worker thread inside a copy of the request's context, and opens
the span there — so nested code writes into that command's trace, and a trace
never leaks between commands even though they share the thread.
"""

from __future__ import annotations

import contextvars
from contextlib import contextmanager

import events

_current: contextvars.ContextVar[dict | None] = contextvars.ContextVar(
    "imperium_trace", default=None
)


def _new_trace() -> dict:
    return {
        "input_tokens": 0,
        "output_tokens": 0,
        "api_calls": 0,
        "models": [],
        "repair_attempts": 0,
        "repair_succeeded": False,
        "scripts": [],
        "command_id": None,
        "client_id": None,
    }


@contextmanager
def span(command_id: str | None = None, client_id: str | None = None):
    """Open a trace for one command; nested code records into it."""
    trace = _new_trace()
    trace["command_id"] = command_id
    trace["client_id"] = client_id
    token = _current.set(trace)
    try:
        yield trace
    finally:
        _current.reset(token)


def current() -> dict | None:
    return _current.get()


def ids() -> dict:
    """The command_id and client_id of the command in this context (None outside one)."""
    trace = _current.get() or {}
    return {"command_id": trace.get("command_id"), "client_id": trace.get("client_id")}


def record_usage(message, model: str = "") -> None:
    """Record token usage from an Anthropic response. Safe to call anywhere."""
    trace = _current.get()
    if trace is None:
        return
    usage = getattr(message, "usage", None)
    input_tokens = (getattr(usage, "input_tokens", 0) or 0) if usage is not None else 0
    output_tokens = (getattr(usage, "output_tokens", 0) or 0) if usage is not None else 0
    trace["input_tokens"] += input_tokens
    trace["output_tokens"] += output_tokens
    trace["api_calls"] += 1
    if model and model not in trace["models"]:
        trace["models"].append(model)
    events.publish(
        "model_call",
        command_id=trace["command_id"],
        client_id=trace["client_id"],
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
    )


def record_repair(error: str = "") -> None:
    """Count one repair call (one request asking the model to fix a script)."""
    trace = _current.get()
    if trace is None:
        return
    trace["repair_attempts"] += 1
    events.publish(
        "repair",
        command_id=trace["command_id"],
        client_id=trace["client_id"],
        attempt=trace["repair_attempts"],
        error=error[:300],
    )


def mark_repaired() -> None:
    """Mark that a repaired script went on to execute successfully."""
    trace = _current.get()
    if trace is None:
        return
    trace["repair_succeeded"] = True


def record_script(script: str) -> None:
    """Record an AppleScript the command executed, for the audit log."""
    trace = _current.get()
    if trace is None:
        return
    script = script.strip()
    trace["scripts"].append(script)
    events.publish(
        "script",
        command_id=trace["command_id"],
        client_id=trace["client_id"],
        preview=script[:400],
        length=len(script),
    )


def snapshot() -> dict:
    """Current trace values, or zeros when no span is open."""
    trace = _current.get()
    return dict(trace) if trace is not None else _new_trace()
