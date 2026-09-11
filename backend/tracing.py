"""Per-command tracing — model token usage, repair attempts, and the AppleScript each command ran.

Anthropic calls happen deep inside the command path (script generation, repair,
project generation), while the audit record is written at the top in
`_execute_command`. Rather than threading a trace argument through every
function, each request opens a context-local accumulator that nested code
writes into.

`contextvars` is the right primitive here: FastAPI copies the context for each
request, and for `def` (sync) endpoints run in the threadpool the context is
copied into the worker thread too — so a trace never leaks between concurrent
commands.
"""

from __future__ import annotations

import contextvars
from contextlib import contextmanager

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
    }


@contextmanager
def span():
    """Open a trace for one command; nested code records into it."""
    token = _current.set(_new_trace())
    try:
        yield _current.get()
    finally:
        _current.reset(token)


def current() -> dict | None:
    return _current.get()


def record_usage(message, model: str = "") -> None:
    """Record token usage from an Anthropic response. Safe to call anywhere."""
    trace = _current.get()
    if trace is None:
        return
    usage = getattr(message, "usage", None)
    if usage is not None:
        trace["input_tokens"] += getattr(usage, "input_tokens", 0) or 0
        trace["output_tokens"] += getattr(usage, "output_tokens", 0) or 0
    trace["api_calls"] += 1
    if model and model not in trace["models"]:
        trace["models"].append(model)


def record_repair() -> None:
    """Count one repair call (one request asking the model to fix a script)."""
    trace = _current.get()
    if trace is None:
        return
    trace["repair_attempts"] += 1


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
    trace["scripts"].append(script.strip())


def snapshot() -> dict:
    """Current trace values, or zeros when no span is open."""
    trace = _current.get()
    return dict(trace) if trace is not None else _new_trace()
