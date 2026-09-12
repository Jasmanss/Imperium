#!/usr/bin/env python3
"""Imperium eval runner.

Two suites, one task file (evals/tasks.yaml):

  offline  Deterministic checks of the safety and reliability layers:
           command classification, the permission gate and confirm flow,
           the script policy gate, the AppleScript validator, auth, the
           retry-with-repair loop, tracing, the audit store, the live event
           stream, the command worker, and the hosted frontend's headers.
           Needs no API key and never drives the Mac: process spawns,
           keystrokes, and model calls are intercepted and fail the task,
           and importing the backend is guarded the same way (only `uname`,
           run by the standard library, is let through). Every task gets its
           own temporary token, config, audit database, event bus, command
           worker, and frontend export directory, so ~/.imperium is never
           read or written. Every stream read and wait is bounded by a
           timeout. Built-in handlers are checked for AppleScript injection
           by capturing the scripts they build.

  live     End-to-end commands against the real agent on a real Mac,
           verified by querying macOS state with osascript. Needs
           ANTHROPIC_API_KEY and Automation/Accessibility permission.
           A command that classifies as destructive is refused at runtime
           even if someone adds it to the task file.

The offline suite is itself mutation-tested: each mutation deliberately breaks
one safety property, and the suite must fail for the mutation to count as
caught.

Usage:
  python3 evals/runner.py                  offline suite + mutation check
  python3 evals/runner.py --live           also run the live suite
  python3 evals/runner.py --only ID [ID..] run selected tasks
  python3 evals/runner.py --no-mutations   skip the mutation check
  python3 evals/runner.py --no-write       do not rewrite evals/RESULTS.md

Exits non-zero if any offline task fails or any mutation survives.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import contextvars
import datetime as dt
import hashlib
import io
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import types
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import yaml

EVALS_DIR = Path(__file__).resolve().parent
ROOT = EVALS_DIR.parent
BACKEND = ROOT / "backend"
TASKS_FILE = EVALS_DIR / "tasks.yaml"
RESULTS_FILE = EVALS_DIR / "RESULTS.md"

sys.path.insert(0, str(BACKEND))


class OfflineViolation(Exception):
    """Offline code tried to reach the Mac, a process, or a model."""


def _refuse_spawns_except_uname(real):
    def spawn(args, *rest, **kwargs):
        program = args[0] if isinstance(args, (list, tuple)) else str(args).split()[0]
        if Path(str(program)).name == "uname":
            return real(args, *rest, **kwargs)
        raise OfflineViolation(f"importing the backend tried to run {args!r}")

    return spawn


# Importing the backend must not reach the Mac either. The standard library's
# `platform` module runs `uname`, which is harmless.
_real_run, _real_popen = subprocess.run, subprocess.Popen
subprocess.run = _refuse_spawns_except_uname(_real_run)
subprocess.Popen = _refuse_spawns_except_uname(_real_popen)
try:
    with contextlib.redirect_stdout(io.StringIO()):
        import applescript_validate
        import audit
        import code_file_actions
        import events
        import frontend_host
        import main
        import permissions
        import policy_gate
        import security
        import tracing

    import pyautogui
    from fastapi.testclient import TestClient
finally:
    subprocess.run, subprocess.Popen = _real_run, _real_popen

# Captured before offline_guards replaces them, for the handler-injection tasks.
_REAL_HANDLERS = {"spotify_control": main.spotify_control, "send_message": main.send_message}


# --- Harness primitives -----------------------------------------------------


class Refused(Exception):
    """A live task was refused because it could cause an outward-facing effect."""


@dataclass
class Result:
    task: dict
    status: str  # pass | fail | error | refused | not_run
    detail: str = ""
    seconds: float = 0.0
    trace: dict = field(default_factory=dict)


class Guard:
    def __init__(self) -> None:
        self.trips: list[str] = []

    def block(self, name: str):
        def blocked(*args, **kwargs):
            self.trips.append(name)
            raise OfflineViolation(f"offline suite attempted {name}")

        return blocked


class Checks:
    def __init__(self) -> None:
        self.failures: list[str] = []

    def expect(self, condition, message: str) -> None:
        if not condition:
            self.failures.append(message)

    def outcome(self, ok_detail: str = "") -> tuple[bool, str]:
        return not self.failures, "; ".join(self.failures) or ok_detail


@contextlib.contextmanager
def patched(*patches: tuple):
    saved = [(obj, name, getattr(obj, name)) for obj, name, _ in patches]
    try:
        for obj, name, value in patches:
            setattr(obj, name, value)
        yield
    finally:
        for obj, name, value in reversed(saved):
            setattr(obj, name, value)


def offline_guards(guard: Guard):
    return patched(
        (subprocess, "run", guard.block("subprocess.run")),
        (subprocess, "Popen", guard.block("subprocess.Popen")),
        (subprocess, "call", guard.block("subprocess.call")),
        (subprocess, "check_call", guard.block("subprocess.check_call")),
        (subprocess, "check_output", guard.block("subprocess.check_output")),
        (os, "system", guard.block("os.system")),
        (os, "popen", guard.block("os.popen")),
        (asyncio, "create_subprocess_exec", guard.block("asyncio.create_subprocess_exec")),
        (asyncio, "create_subprocess_shell", guard.block("asyncio.create_subprocess_shell")),
        (pyautogui, "write", guard.block("pyautogui.write")),
        (pyautogui, "typewrite", guard.block("pyautogui.typewrite")),
        (pyautogui, "press", guard.block("pyautogui.press")),
        (pyautogui, "hotkey", guard.block("pyautogui.hotkey")),
        (pyautogui, "click", guard.block("pyautogui.click")),
        (main.claude.messages, "create", guard.block("anthropic messages.create")),
        (code_file_actions._claude.messages, "create", guard.block("anthropic messages.create")),
        (applescript_validate.anthropic, "Anthropic", guard.block("anthropic.Anthropic")),
        (main, "send_message", guard.block("send_message handler")),
        (main, "compose_email", guard.block("compose_email handler")),
        (main, "git_command", guard.block("git_command handler")),
        (main, "create_project", guard.block("create_project handler")),
        (main, "spotify_control", guard.block("spotify_control handler")),
    )


@contextlib.contextmanager
def isolated_state(base: Path):
    state = Path(tempfile.mkdtemp(dir=base)) / "imperium"
    # Built through the module's own factory, so a mutation of it applies.
    worker = main._new_command_worker()
    with patched(
        (security, "IMPERIUM_DIR", state),
        (security, "TOKEN_FILE", state / "token"),
        (security, "_token_cache", None),
        (permissions, "CONFIG_FILE", state / "permissions.json"),
        (permissions, "_config_cache", None),
        (permissions, "_pending", {}),
        (audit, "DB_FILE", state / "audit.db"),
        (events, "bus", events.EventBus()),
        (main, "_command_worker", worker),
        # Missing unless the task builds an export there.
        (main.frontend, "directory", state.parent / "frontend-out"),
        (main.frontend, "_files", None),
        (main.frontend, "_hash_cache", {}),
    ):
        try:
            yield state
        finally:
            # A command still on the worker must finish while the token, audit
            # database, and event bus are this task's own, never ~/.imperium.
            worker.shutdown(wait=True)


def auth_headers(kind: str) -> dict:
    token = security.get_token()
    return {
        "valid": {"Authorization": f"Bearer {token}"},
        "lowercase_scheme": {"Authorization": f"bearer {token}"},
        "none": {},
        "query_param": {},
        "wrong": {"Authorization": "Bearer not-the-pairing-token"},
        "no_scheme": {"Authorization": token},
        "basic_scheme": {"Authorization": f"Basic {token}"},
        "empty_bearer": {"Authorization": "Bearer "},
        "truncated": {"Authorization": f"Bearer {token[:-1]}"},
        "extended": {"Authorization": f"Bearer {token}x"},
    }[kind]


def _json_or_none(response):
    try:
        body = response.json()
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


def _fake_message(script: str, action: str, input_tokens: int, output_tokens: int):
    return types.SimpleNamespace(
        content=[types.SimpleNamespace(text=json.dumps({"script": script, "action": action}))],
        usage=types.SimpleNamespace(input_tokens=input_tokens, output_tokens=output_tokens),
    )


def _fake_anthropic(spec: dict | None):
    class FakeAnthropic:
        def __init__(self, *args, **kwargs):
            def create(**kwargs):
                if spec is None:
                    raise RuntimeError("repair model unavailable")
                return _fake_message(
                    spec["script"], "repaired", spec["input_tokens"], spec["output_tokens"]
                )

            self.messages = types.SimpleNamespace(create=create)

    return FakeAnthropic


OK_RUN = {"stdout": "", "stderr": "", "returncode": 0}
RUNTIME_ERROR = {"stdout": "", "stderr": "execution error: Can't get window 1 (-1728)", "returncode": 1}
TIMEOUT_ERROR = {"stdout": "", "stderr": "Error: AppleScript timed out after 30s", "returncode": 1}
SYNTAX_ERROR = {
    "stdout": "",
    "stderr": "12:18: syntax error: Expected end of line but found identifier. (-2741)",
    "returncode": 1,
}
POLICY_BLOCK = {
    "stdout": "",
    "stderr": "Blocked by policy: shell execution from AppleScript is not allowed",
    "returncode": 1,
}


class StreamTimeout(Exception):
    """A bounded wait in a streaming or concurrency task ran out."""


async def _bounded(awaitable, timeout: float, what: str):
    try:
        return await asyncio.wait_for(awaitable, max(timeout, 0))
    except asyncio.TimeoutError:
        raise StreamTimeout(f"{what} within {timeout:g}s") from None


async def _until(predicate, timeout: float, what: str) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        if loop.time() > deadline:
            raise StreamTimeout(f"{what} within {timeout:g}s")
        await asyncio.sleep(0.005)


def _run_async(coroutine, timeout: float = 15.0):
    """Run a task's coroutine on a fresh event loop, bounded as a whole."""
    return asyncio.run(_bounded(coroutine, timeout, "the task did not finish"))


class AsgiCall:
    """One request driven straight through the ASGI app.

    TestClient returns only once the app has finished, which an event stream
    never does, so streaming and concurrency tasks drive the app on their own
    event loop and bound every wait. Create calls inside that running loop.
    """

    def __init__(self, method: str, path: str, headers: dict | None = None, json_body=None) -> None:
        path, _, query = path.partition("?")
        self.label = f"{method} {path}"
        self._body = b"" if json_body is None else json.dumps(json_body).encode()
        raw_headers = [(b"host", b"testserver")]
        if json_body is not None:
            raw_headers.append((b"content-type", b"application/json"))
            raw_headers.append((b"content-length", str(len(self._body)).encode()))
        for name, value in (headers or {}).items():
            raw_headers.append((name.lower().encode("latin-1"), value.encode("latin-1")))
        self.scope = {
            "type": "http",
            # Spec 2.3: a streaming response learns of a disconnect through receive().
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "query_string": query.encode(),
            "root_path": "",
            "headers": raw_headers,
            "client": ("127.0.0.1", 50000),
            "server": ("testserver", 80),
        }
        self.status: int | None = None
        self.headers: dict = {}
        self.task: asyncio.Future | None = None
        self._body_sent = False
        self._started = asyncio.Event()
        self._disconnected = asyncio.Event()
        self._chunks: asyncio.Queue = asyncio.Queue()
        self._text = ""
        self._ended = False

    async def _receive(self) -> dict:
        if not self._body_sent:
            self._body_sent = True
            return {"type": "http.request", "body": self._body, "more_body": False}
        await self._disconnected.wait()
        return {"type": "http.disconnect"}

    async def _send(self, message: dict) -> None:
        if message["type"] == "http.response.start":
            self.status = message["status"]
            self.headers = {
                name.decode("latin-1").lower(): value.decode("latin-1") for name, value in message["headers"]
            }
            self._started.set()
        elif message["type"] == "http.response.body":
            self._chunks.put_nowait(message.get("body", b""))
            if not message.get("more_body", False):
                self._chunks.put_nowait(None)

    def begin(self) -> AsgiCall:
        """Send the request without waiting for the response."""
        if self.task is None:
            self.task = asyncio.ensure_future(main.app(self.scope, self._receive, self._send))
        return self

    async def start(self, timeout: float = 2.0) -> AsgiCall:
        """Send the request and wait for the response to start."""
        self.begin()
        await _bounded(self._started.wait(), timeout, f"{self.label} started no response")
        return self

    async def _read(self, deadline: float) -> None:
        remaining = deadline - asyncio.get_running_loop().time()
        chunk = await _bounded(self._chunks.get(), remaining, f"{self.label} sent nothing more")
        if chunk is None:
            self._ended = True
        else:
            self._text += chunk.decode("utf-8")

    async def frame(self, timeout: float = 2.0) -> str | None:
        """The next event-stream frame without its blank line; None once the stream has ended."""
        await self.start(timeout)
        deadline = asyncio.get_running_loop().time() + timeout
        while "\n\n" not in self._text:
            if self._ended:
                return None
            await self._read(deadline)
        frame, self._text = self._text.split("\n\n", 1)
        return frame

    async def json(self, timeout: float = 2.0):
        """The whole body parsed as JSON, or None when it is not JSON."""
        await self.start(timeout)
        deadline = asyncio.get_running_loop().time() + timeout
        while not self._ended:
            await self._read(deadline)
        try:
            return json.loads(self._text)
        except ValueError:
            return None

    async def close(self, timeout: float = 2.0) -> None:
        """Disconnect, and wait for the app to finish with the request."""
        self._disconnected.set()
        if self.task is None:
            return
        done, _ = await asyncio.wait({self.task}, timeout=timeout)
        if not done:
            self.task.cancel()
            await asyncio.wait({self.task}, timeout=timeout)
            raise StreamTimeout(f"{self.label} kept running {timeout:g}s after the client disconnected")
        if not self.task.cancelled():
            self.task.exception()


def _sse_frame(frame: str | None) -> dict:
    """The fields of one event-stream frame; `data` is parsed JSON when it is JSON."""
    parsed = {"raw": frame or "", "id": None, "event": None, "data": None, "data_lines": 0, "comments": [], "other": []}
    for line in (frame or "").split("\n"):
        if line.startswith(":"):
            parsed["comments"].append(line[1:].strip())
            continue
        name, _, value = line.partition(":")
        value = value[1:] if value.startswith(" ") else value
        if name == "data":
            parsed["data_lines"] += 1
            try:
                parsed["data"] = json.loads(value)
            except ValueError:
                parsed["data"] = value
        elif name in ("id", "event"):
            parsed[name] = value
        elif line:
            parsed["other"].append(line)
    return parsed


def _frame_data(frame: dict) -> dict:
    return frame["data"] if isinstance(frame["data"], dict) else {}


def _published(event_type: str | None = None, **fields) -> list[dict]:
    """Events on this task's bus, oldest first, filtered by type and field values."""
    return [
        event
        for _, event in events.bus.buffered()
        if (event_type is None or event["type"] == event_type)
        and all(event.get(key) == value for key, value in fields.items())
    ]


# --- Offline executors ------------------------------------------------------


def run_classify(task: dict) -> tuple[bool, str]:
    c = Checks()
    category = main._classify_command(task["command"])
    c.expect(
        category == task["expect_category"],
        f"classified as {category!r}, expected {task['expect_category']!r}",
    )
    if "expect_tier" in task:
        tier = permissions.tier_for(category)
        c.expect(tier == task["expect_tier"], f"tier {tier!r}, expected {task['expect_tier']!r}")
    return c.outcome(f"-> {category}")


def run_policy(task: dict) -> tuple[bool, str]:
    c = Checks()
    # Set the flag directly: mutating the product's confirm route must not also
    # switch off this task's setup.
    token = permissions._confirmed.set(True) if task.get("confirmed") else None
    try:
        allowed, reason = policy_gate.check_script(task["script"])
    finally:
        if token is not None:
            permissions._confirmed.reset(token)
    c.expect(
        allowed == task["expect_allowed"],
        f"allowed={allowed}, expected {task['expect_allowed']} (reason: {reason or 'none'})",
    )
    if task.get("reason_contains"):
        c.expect(
            task["reason_contains"].lower() in reason.lower(),
            f"reason {reason!r} does not mention {task['reason_contains']!r}",
        )
    return c.outcome(reason or "allowed")


def run_validate(task: dict) -> tuple[bool, str]:
    c = Checks()
    valid, error = applescript_validate.validate_applescript(task["script"])
    c.expect(
        valid == task["expect_valid"],
        f"valid={valid}, expected {task['expect_valid']} ({error or 'no error'})",
    )
    if task.get("error_contains"):
        c.expect(
            task["error_contains"].lower() in error.lower(),
            f"error {error!r} does not mention {task['error_contains']!r}",
        )
    return c.outcome(error or "valid")


def run_http(task: dict) -> tuple[bool, str]:
    c = Checks()
    client = TestClient(main.app, raise_server_exceptions=False)
    auth = task.get("auth", "valid")
    path = task["path"]
    if auth == "query_param":
        path += ("&" if "?" in path else "?") + f"token={security.get_token()}"
    response = client.request(
        task.get("method", "POST"), path, headers=auth_headers(auth), json=task.get("json")
    )
    expected_status = task.get("expect_status", 200)
    c.expect(
        response.status_code == expected_status,
        f"HTTP {response.status_code}, expected {expected_status}",
    )
    body = _json_or_none(response)
    for key, value in (task.get("expect_json") or {}).items():
        actual = None if body is None else body.get(key)
        c.expect(actual == value, f"json[{key!r}] = {actual!r}, expected {value!r}")
    for key, fragment in (task.get("expect_json_contains") or {}).items():
        actual = "" if body is None else str(body.get(key, ""))
        c.expect(
            str(fragment).lower() in actual.lower(),
            f"json[{key!r}] = {actual!r} does not contain {fragment!r}",
        )
    for key in task.get("expect_json_keys") or []:
        c.expect(body is not None and key in body, f"response lacks key {key!r}")
    for name, value in (task.get("expect_headers") or {}).items():
        actual = response.headers.get(name)
        c.expect(actual == value, f"header {name} = {actual!r}, expected {value!r}")
    decisions = [entry["decision"] for entry in audit.recent(200)]
    for decision in task.get("expect_audit") or []:
        c.expect(decision in decisions, f"audit lacks {decision!r} (has {decisions})")
    for decision in task.get("forbid_audit") or []:
        c.expect(decision not in decisions, f"audit contains forbidden {decision!r}")
    return c.outcome(f"HTTP {response.status_code}")


_HEX12 = re.compile(r"[0-9a-f]{12}")

# A parked command as GET /pending lists it; POST /text-command adds transcript and action.
PARKED_KEYS = {
    "requires_confirmation", "pending_id", "command_id", "client_id", "command", "category",
    "tier", "details", "created_at", "expires_at", "ttl_seconds", "server_time",
}

# Every event type's fields besides type and ts.
EVENT_FIELDS = {
    "command": {"command_id", "client_id", "command", "category", "tier"},
    "pending": {"command_id", "client_id", "pending_id", "category", "tier", "details", "expires_at"},
    "confirmed": {"command_id", "client_id", "pending_id"},
    "cancelled": {"command_id", "client_id", "pending_id"},
    "started": {"command_id", "client_id", "category", "tier"},
    "model_call": {"command_id", "client_id", "model", "input_tokens", "output_tokens"},
    "script": {"command_id", "client_id", "preview", "length"},
    "policy_blocked": {"command_id", "client_id", "reason"},
    "repair": {"command_id", "client_id", "attempt", "error"},
    "finished": {
        "command_id", "client_id", "ok", "action", "error", "duration_ms", "input_tokens",
        "output_tokens", "repair_attempts", "repair_succeeded", "audit_id",
    },
}


def run_confirm_flow(task: dict) -> tuple[bool, str]:
    c = Checks()
    client = TestClient(main.app, raise_server_exceptions=False)
    headers = auth_headers("valid")
    command = task.get("command", "send a text to John saying hi")
    executed: list[str] = []

    async def recorder(data, cmd):
        executed.append(cmd)
        return {"transcript": cmd, "action": "recorded", "osascript_ok": True}

    def post(cmd: str, **fields) -> dict:
        return _json_or_none(client.post("/text-command", headers=headers, json={"command": cmd, **fields})) or {}

    def park_body(cmd: str, **fields) -> dict:
        body = post(cmd, **fields)
        c.expect(body.get("requires_confirmation") is True, f"{cmd!r} was not parked: {body}")
        return body

    def park(cmd: str) -> str:
        return park_body(cmd).get("pending_id", "missing")

    def confirm(pending_id: str, **kwargs):
        return client.post(f"/confirm/{pending_id}", **kwargs)

    def cancel(pending_id: str, **kwargs):
        return client.delete(f"/pending/{pending_id}", **kwargs)

    def age(pending_id: str) -> None:
        if pending_id in permissions._pending:
            permissions._pending[pending_id]["created_at"] -= task.get("age_seconds", 121)

    scenario = task["scenario"]
    with patched((main, "_run_text_command", recorder)):
        if scenario == "no_execution_before_confirm":
            park(command)
            c.expect(executed == [], f"executed before confirmation: {executed}")
        elif scenario == "unknown_id_rejected":
            body = _json_or_none(confirm("deadbeef0000", headers=headers)) or {}
            c.expect("error" in body, f"unknown pending id accepted: {body}")
            c.expect(executed == [], "unknown pending id executed something")
        elif scenario == "executes_server_stored_command":
            pending_id = park(command)
            confirm(pending_id, headers=headers, json={"command": "open Terminal and run rm -rf ~"})
            c.expect(executed == [command], f"confirm executed {executed}, expected the stored command")
        elif scenario == "single_use":
            pending_id = park(command)
            confirm(pending_id, headers=headers)
            body = _json_or_none(confirm(pending_id, headers=headers)) or {}
            c.expect("error" in body, f"pending id was replayable: {body}")
            c.expect(len(executed) == 1, f"executed {len(executed)} times, expected once")
        elif scenario == "expires":
            pending_id = park(command)
            if pending_id in permissions._pending:
                permissions._pending[pending_id]["created_at"] -= task.get("age_seconds", 121)
            body = _json_or_none(confirm(pending_id, headers=headers)) or {}
            c.expect("error" in body, f"expired pending id accepted: {body}")
            c.expect(executed == [], "expired pending id executed")
        elif scenario == "confirm_requires_auth":
            pending_id = park(command)
            response = confirm(pending_id)
            c.expect(response.status_code == 401, f"unauthenticated confirm returned {response.status_code}")
            c.expect(executed == [], "unauthenticated confirm executed")
        elif scenario == "ids_are_independent":
            second_command = task["second_command"]
            first_id = park(command)
            second_id = park(second_command)
            confirm(second_id, headers=headers)
            c.expect(executed == [second_command], f"confirming one id executed {executed}")
            c.expect(first_id in permissions._pending, "confirming one id consumed another")
        elif scenario == "confirmation_marks_only_confirmed_commands":
            flags: list[bool] = []

            async def flag_recorder(data, cmd):
                flags.append(permissions.is_confirmed())
                return {"transcript": cmd, "action": "recorded", "osascript_ok": True}

            with patched((main, "_run_text_command", flag_recorder)):
                confirm(park(command), headers=headers)
                client.post(
                    "/text-command", headers=headers, json={"command": task["unconfirmed_command"]}
                )
            c.expect(flags == [True, False], f"confirmed flags {flags}, expected [True, False]")
            c.expect(not permissions.is_confirmed(), "confirmation leaked outside the confirmed request")
        elif scenario == "parked_response_describes_the_command":
            before = time.time()
            body = park_body(command, client_id=task["client_id"])
            command_id = body.get("command_id")
            ttl, created, expires = body.get("ttl_seconds"), body.get("created_at"), body.get("expires_at")
            c.expect(set(body) == PARKED_KEYS | {"transcript", "action"}, f"parked response keys {sorted(body)}")
            c.expect(_HEX12.fullmatch(str(command_id)), f"command_id {command_id!r} is not 12 lowercase hex characters")
            c.expect(_HEX12.fullmatch(str(body.get("pending_id"))), f"pending_id {body.get('pending_id')!r}")
            c.expect(body.get("client_id") == task["client_id"], f"client_id came back as {body.get('client_id')!r}")
            c.expect(body.get("transcript") == command and body.get("command") == command, "the parked command text changed")
            c.expect(body.get("tier") == "destructive", f"tier {body.get('tier')!r}")
            c.expect(type(ttl) is int and ttl == permissions.PENDING_TTL_SECONDS, f"ttl_seconds {ttl!r}")
            c.expect(isinstance(created, float) and before <= created <= time.time(), f"created_at {created!r}")
            c.expect(
                isinstance(expires, float) and type(ttl) is int and isinstance(created, float)
                and abs(expires - created - ttl) < 1e-6,
                f"expires_at {expires!r} is not created_at + ttl_seconds",
            )
            server_time = body.get("server_time")
            c.expect(isinstance(server_time, float) and abs(server_time - time.time()) < 5, f"server_time {server_time!r}")
            c.expect(
                body.get("details") == task["expect_details"],
                f"details {body.get('details')!r}, expected {task['expect_details']!r}",
            )
            announced = _published("pending", command_id=command_id)
            c.expect(len(announced) == 1, f"{len(announced)} pending events for the parked command")
            for key in ("client_id", "pending_id", "category", "tier", "details", "expires_at"):
                c.expect(
                    bool(announced) and announced[0].get(key) == body.get(key),
                    f"the pending event's {key} differs from the response",
                )
            kinds = [event["type"] for event in _published(command_id=command_id)]
            c.expect(kinds == ["command", "pending"], f"events for the parked command: {kinds}")
            rows = [(row["decision"], row["action"]) for row in audit.page(10, command_id=command_id)["entries"]]
            c.expect(rows == [("pending_confirmation", body.get("action"))], f"audit rows for the parked command: {rows}")
            c.expect(executed == [], f"parking executed {executed}")
        elif scenario == "details_never_look_anything_up":
            lookups: list[str] = []
            with patched((main, "_lookup_contact_phone", lambda name: lookups.append(name) or "+15551234567")):
                for case in task["cases"]:
                    body = park_body(case["command"])
                    c.expect(
                        body.get("details") == case["expect_details"],
                        f"{case['command']!r}: details {body.get('details')!r}, expected {case['expect_details']!r}",
                    )
            c.expect(lookups == [], f"parking looked up contacts: {lookups}")
            c.expect(executed == [], f"parking executed {executed}")
        elif scenario == "client_id_validation":
            for case in task["cases"]:
                for cmd in (command, task["act_command"]):
                    body = post(cmd, client_id=case["client_id"])
                    returned = body.get("client_id", "missing")
                    c.expect(
                        returned == case["expect"],
                        f"client_id {case['client_id']!r} on {cmd!r} came back as {returned!r}, expected {case['expect']!r}",
                    )
                    announced = _published("command", command_id=body.get("command_id"))
                    carried = announced[0].get("client_id", "missing") if announced else "no event"
                    c.expect(
                        carried == case["expect"],
                        f"client_id {case['client_id']!r} reached the command event as {carried!r}",
                    )
        elif scenario == "cancel_revokes":
            parked = park_body(command, client_id="phone")
            pending_id, command_id = parked.get("pending_id", "missing"), parked.get("command_id")
            response = cancel(pending_id, headers=headers)
            body = _json_or_none(response) or {}
            c.expect(
                response.status_code == 200
                and body == {"cancelled": True, "pending_id": pending_id, "command_id": command_id},
                f"cancel returned HTTP {response.status_code} {body}",
            )
            confirmed = _json_or_none(confirm(pending_id, headers=headers)) or {}
            c.expect("error" in confirmed, f"a cancelled id was confirmed: {confirmed}")
            again = cancel(pending_id, headers=headers)
            c.expect(
                again.status_code == 404 and "error" in (_json_or_none(again) or {}),
                f"cancelling twice returned HTTP {again.status_code}",
            )
            listed = (_json_or_none(client.get("/pending", headers=headers)) or {}).get("pending")
            c.expect(listed == [], f"a cancelled id is still listed: {listed}")
            c.expect(executed == [], f"a cancelled command executed: {executed}")
            decisions = [row["decision"] for row in audit.page(10, command_id=command_id)["entries"]]
            c.expect(decisions == ["cancelled", "pending_confirmation"], f"audit rows for the command: {decisions}")
            kinds = [event["type"] for event in _published(command_id=command_id)]
            c.expect(kinds == ["command", "pending", "cancelled"], f"events for the command: {kinds}")
            c.expect(
                len(_published("cancelled", pending_id=pending_id, client_id="phone")) == 1,
                "the cancelled event does not carry the pending_id and client_id",
            )
        elif scenario == "cancel_requires_auth":
            pending_id = park(command)
            for kind in ("none", "wrong", "query_param"):
                path = f"/pending/{pending_id}"
                if kind == "query_param":
                    path += f"?token={security.get_token()}"
                response = client.delete(path, headers=auth_headers(kind))
                c.expect(response.status_code == 401, f"cancel with {kind} auth returned HTTP {response.status_code}")
            c.expect(pending_id in permissions._pending, "an unauthenticated cancel revoked the command")
            c.expect(not _published("cancelled"), "an unauthenticated cancel published an event")
            confirm(pending_id, headers=headers)
            c.expect(executed == [command], f"after a refused cancel, confirming executed {executed}")
        elif scenario == "unknown_and_expired_ids_have_no_side_effects":
            kept = park(task["second_command"])
            expired = park(command)
            age(expired)
            rows, published = len(audit.recent(200)), len(events.bus.buffered())
            for pending_id in ("deadbeef0000", expired):
                deleted = cancel(pending_id, headers=headers)
                c.expect(
                    deleted.status_code == 404
                    and (_json_or_none(deleted) or {}).get("error") == "Confirmation expired or already used.",
                    f"cancelling {pending_id} returned HTTP {deleted.status_code} {deleted.text}",
                )
                response = confirm(pending_id, headers=headers)
                error = str((_json_or_none(response) or {}).get("error", ""))
                c.expect(
                    response.status_code == 200 and error.startswith("Confirmation expired or already used"),
                    f"confirming {pending_id} returned HTTP {response.status_code} {response.text}",
                )
            c.expect(executed == [], f"an unknown or expired id executed {executed}")
            c.expect(len(audit.recent(200)) == rows, "a refused confirm or cancel wrote audit rows")
            c.expect(len(events.bus.buffered()) == published, "a refused confirm or cancel published events")
            c.expect(kept in permissions._pending, "a refused confirm or cancel consumed another parked command")
        elif scenario == "pending_list_excludes_expired":
            stale = park_body(command)
            fresh = [park_body(cmd, client_id=f"tab-{n}") for n, cmd in enumerate(task["more_commands"])]
            age(stale.get("pending_id", "missing"))
            response = client.get("/pending", headers=headers)
            body = _json_or_none(response) or {}
            listed = body.get("pending") or []
            c.expect(
                response.status_code == 200 and set(body) == {"pending", "server_time"},
                f"GET /pending returned HTTP {response.status_code} with keys {sorted(body)}",
            )
            c.expect(
                [entry.get("pending_id") for entry in listed] == [entry.get("pending_id") for entry in fresh],
                f"listed {[entry.get('pending_id') for entry in listed]}, expected only the unexpired ids, oldest first",
            )
            for entry, parked in zip(listed, fresh):
                expected = {key: value for key, value in parked.items() if key not in ("transcript", "action", "server_time")}
                c.expect(
                    set(entry) == PARKED_KEYS and {key: value for key, value in entry.items() if key != "server_time"} == expected,
                    f"a listed entry differs from its parking response: {entry}",
                )
                c.expect(entry.get("expires_at", 0) > body.get("server_time", 0), f"a listed entry had expired: {entry}")
        elif scenario == "confirm_keeps_command_ids":
            parked = park_body(command, client_id="phone-2")
            command_id = parked.get("command_id")
            result = _json_or_none(confirm(parked.get("pending_id", "missing"), headers=headers)) or {}
            c.expect(
                result.get("command_id") == command_id and result.get("client_id") == "phone-2",
                f"confirm returned command_id {result.get('command_id')!r} and client_id {result.get('client_id')!r}",
            )
            c.expect(
                result.get("ok") is True and type(result.get("duration_ms")) is int and type(result.get("audit_id")) is int,
                f"executed response {result}",
            )
            c.expect(
                result.get("action") == "recorded" and result.get("transcript") == command,
                f"the handler's keys were not passed through: {result}",
            )
            rows = audit.page(10, command_id=command_id)["entries"]
            decisions = [row["decision"] for row in rows]
            c.expect(decisions == ["executed", "confirmed", "pending_confirmation"], f"audit rows for the command: {decisions}")
            c.expect(
                bool(rows) and rows[0]["id"] == result.get("audit_id") and rows[0]["action"] == "recorded",
                f"the executed row is not the response's audit_id: {rows[:1]}",
            )
            kinds = [event["type"] for event in _published(command_id=command_id)]
            c.expect(kinds == ["command", "pending", "confirmed", "started", "finished"], f"events for the command: {kinds}")
            finished = _published("finished", command_id=command_id, client_id="phone-2")
            c.expect(
                len(finished) == 1 and finished[0].get("audit_id") == result.get("audit_id"),
                f"finished events for the command: {finished}",
            )
        else:
            return False, f"unknown confirm_flow scenario {scenario!r}"
    return c.outcome(scenario.replace("_", " "))


def run_retry(task: dict) -> tuple[bool, str]:
    c = Checks()
    seen: dict[str, list[str]] = {"static": [], "runtime": []}
    spotify = 'tell application "Spotify" to play'
    placeholder = 'set theURL to "https://example.com"'

    def fix_returning(script: str):
        def fix(original, static_error, runtime_error=""):
            seen["static"].append(static_error)
            seen["runtime"].append(runtime_error)
            return script, "repaired"

        return fix

    def fix_raises(*args, **kwargs):
        raise RuntimeError("repair model unavailable")

    def fails_once(error=RUNTIME_ERROR):
        calls = {"n": 0}

        def pipe(script):
            calls["n"] += 1
            return error if calls["n"] == 1 else OK_RUN

        return pipe

    scenarios = {
        "success_first_try": (spotify, lambda s: OK_RUN, fix_raises),
        "runtime_error_repaired": (spotify, fails_once(), fix_returning(spotify)),
        "validation_error_repaired": (
            placeholder,
            lambda s: OK_RUN,
            fix_returning('tell application "Google Chrome" to activate'),
        ),
        "bounded_at_max": (spotify, lambda s: RUNTIME_ERROR, fix_returning(spotify)),
        "policy_block_is_terminal": (spotify, lambda s: POLICY_BLOCK, fix_raises),
        "repair_raises": (spotify, lambda s: RUNTIME_ERROR, fix_raises),
        "repair_cannot_bypass_policy_gate": (
            placeholder,
            None,
            fix_returning('do shell script "rm -rf ~"'),
        ),
        "timeout_is_terminal": (spotify, lambda s: TIMEOUT_ERROR, fix_raises),
        "execution_error_not_rerun_when_confirmed": (spotify, lambda s: RUNTIME_ERROR, fix_returning(spotify)),
        "syntax_error_repaired_when_confirmed": (spotify, fails_once(SYNTAX_ERROR), fix_returning(spotify)),
        "invalid_and_disallowed_is_blocked_not_repaired": (
            'do shell script "open -a Google Chrome https://example.com"',
            None,
            fix_raises,
        ),
    }
    scenario = task["scenario"]
    if scenario not in scenarios:
        return False, f"unknown retry scenario {scenario!r}"

    script, pipe, fix = scenarios[scenario]
    patches = [(main, "fix_applescript_with_claude", fix)]
    if pipe is not None:
        patches.append((main, "_osascript_pipe", pipe))
    token = permissions._confirmed.set(True) if task.get("confirmed") else None
    try:
        with patched(*patches), tracing.span() as span:
            result, _ = main.run_applescript(script, "original")
    finally:
        if token is not None:
            permissions._confirmed.reset(token)

    expect = task["expect"]
    c.expect(result["returncode"] == expect["returncode"], f"returncode {result['returncode']}")
    c.expect(
        span["repair_attempts"] == expect["repair_attempts"],
        f"{span['repair_attempts']} repair attempts, expected {expect['repair_attempts']}",
    )
    c.expect(
        span["repair_succeeded"] == expect["repair_succeeded"],
        f"repair_succeeded={span['repair_succeeded']}",
    )
    if "stderr_startswith" in expect:
        c.expect(
            result["stderr"].startswith(expect["stderr_startswith"]),
            f"stderr {result['stderr']!r}",
        )
    if "stderr_contains" in expect:
        c.expect(expect["stderr_contains"] in result["stderr"], f"stderr {result['stderr']!r}")
    if "runtime_error_contains" in expect:
        c.expect(
            any(expect["runtime_error_contains"] in e for e in seen["runtime"]),
            f"runtime error never reached the repair prompt (saw {seen['runtime']})",
        )
    if "static_error_contains" in expect:
        c.expect(
            any(expect["static_error_contains"] in e for e in seen["static"]),
            f"validation error never reached the repair prompt (saw {seen['static']})",
        )
    return c.outcome(
        f"rc={result['returncode']}, repairs={span['repair_attempts']}"
    )


def run_tracing(task: dict) -> tuple[bool, str]:
    c = Checks()
    scenario = task["scenario"]

    if scenario == "context_isolation":

        async def worker(n: int) -> int:
            with tracing.span() as span:
                for _ in range(n):
                    await asyncio.sleep(0)
                    tracing.record_usage(_fake_message("", "", 1, 0))
                return span["input_tokens"]

        async def interleaved():
            return await asyncio.gather(worker(3), worker(7), worker(11))

        counts = asyncio.run(interleaved())
        c.expect(counts == [3, 7, 11], f"traces leaked between concurrent commands: {counts}")
        return c.outcome(f"per-command token counts {counts}")

    if scenario == "no_open_trace_is_noop":
        tracing.record_usage(_fake_message("", "", 5, 5))
        tracing.record_repair()
        tracing.mark_repaired()
        c.expect(tracing.current() is None, "recording outside a command opened a trace")
        return c.outcome("recording outside a command is a no-op")

    if scenario == "command_raises":

        async def crashes(data, cmd):
            raise RuntimeError("handler crashed")

        with patched((main, "_run_text_command", crashes)):
            result = asyncio.run(
                main._execute_command({"command": "open notes"}, "open notes", "applescript_general", "act")
            )
        rows = audit.recent(1)
        row = rows[0] if rows else {}
        c.expect("error" in result, f"the crash was not reported to the caller: {result}")
        c.expect(row.get("decision") == "failed", f"audit decision {row.get('decision')!r}, expected 'failed'")
        c.expect("RuntimeError" in (row.get("error") or ""), f"audit error {row.get('error')!r} does not name the crash")
        return c.outcome("crash recorded as a failed command")

    generation = task["generation"]
    outcomes = list(task.get("osascript_results", ["ok"]))

    def pipe(script):
        outcome = outcomes.pop(0) if len(outcomes) > 1 else outcomes[0]
        return OK_RUN if outcome == "ok" else RUNTIME_ERROR

    command = task.get("command", "open notes")
    patches = [
        (
            main.claude.messages,
            "create",
            lambda **kw: _fake_message(
                generation["script"],
                "generated",
                generation["input_tokens"],
                generation["output_tokens"],
            ),
        ),
        (applescript_validate.anthropic, "Anthropic", _fake_anthropic(task.get("repair"))),
    ]
    if not task.get("real_pipe"):
        patches.append((main, "_osascript_pipe", pipe))
    elif task.get("fake_osascript"):
        patches.append(
            (subprocess, "run", lambda args, **kw: types.SimpleNamespace(returncode=0, stdout="", stderr=""))
        )
    with patched(*patches):
        if task.get("via_http"):
            TestClient(main.app, raise_server_exceptions=False).post(
                "/text-command", headers=auth_headers("valid"), json={"command": command}
            )
        else:
            asyncio.run(
                main._execute_command({"command": command}, command, "applescript_general", "act")
            )

    rows = audit.recent(200)
    c.expect(bool(rows), "no audit row written")
    row = rows[0] if rows else {}
    for key, value in task["expect"].items():
        c.expect(row.get(key) == value, f"audit {key} = {row.get(key)!r}, expected {value!r}")
    if task.get("expect_error_contains"):
        c.expect(
            task["expect_error_contains"] in (row.get("error") or ""),
            f"audit error {row.get('error')!r} does not contain {task['expect_error_contains']!r}",
        )
    decisions = [r["decision"] for r in rows]
    for decision in task.get("expect_audit_decisions") or []:
        c.expect(decision in decisions, f"audit lacks {decision!r} (has {decisions})")
    if task.get("expect_script_contains"):
        c.expect(
            task["expect_script_contains"] in (row.get("script") or ""),
            f"audit did not record the executed script (script column: {row.get('script')!r})",
        )
    return c.outcome(
        f"tokens {row.get('input_tokens')}/{row.get('output_tokens')}, repairs {row.get('repair_attempts')}"
    )


LEGACY_AUDIT_SCHEMA = """
CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    command TEXT,
    category TEXT,
    tier TEXT,
    decision TEXT NOT NULL,
    script TEXT,
    error TEXT,
    ok INTEGER,
    duration_ms INTEGER
);
"""


# The columns v2 added to the legacy table; v3 adds command_id and action.
V2_AUDIT_COLUMNS = (
    "input_tokens INTEGER", "output_tokens INTEGER", "api_calls INTEGER",
    "models TEXT", "repair_attempts INTEGER", "repair_succeeded INTEGER",
)


def run_migration(task: dict) -> tuple[bool, str]:
    c = Checks()
    audit.DB_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    conn = sqlite3.connect(audit.DB_FILE)
    conn.execute(LEGACY_AUDIT_SCHEMA)
    if task.get("legacy_version", 1) >= 2:
        for column in V2_AUDIT_COLUMNS:
            conn.execute(f"ALTER TABLE audit ADD COLUMN {column}")
    conn.execute("INSERT INTO audit (ts, command, decision) VALUES (1.0, 'legacy row', 'executed')")
    conn.commit()
    conn.close()

    command_id = task.get("command_id")
    audit.log_event(
        "executed",
        command="post-migration row",
        trace={"input_tokens": 7},
        command_id=command_id,
        action=task.get("action"),
    )
    if command_id:
        found = [
            (entry["command"], entry["command_id"], entry["action"])
            for entry in audit.page(10, command_id=command_id)["entries"]
        ]
        c.expect(
            found == [("post-migration row", command_id, task["action"])],
            f"reading the migrated database by command_id found {found}",
        )

    conn = sqlite3.connect(audit.DB_FILE)
    columns = {row[1] for row in conn.execute("PRAGMA table_info(audit)")}
    rows = conn.execute("SELECT command, input_tokens FROM audit ORDER BY id").fetchall()
    conn.close()

    missing = sorted(set(task["expect_columns"]) - columns)
    c.expect(not missing, f"columns not added to the existing table: {missing}")
    c.expect(rows[:1] == [("legacy row", None)], f"legacy row not preserved: {rows[:1]}")
    c.expect(rows[1:] == [("post-migration row", 7)], f"new row not written after migration: {rows[1:]}")
    return c.outcome(f"{len(columns)} columns, {len(rows)} rows")


def run_stats(task: dict) -> tuple[bool, str]:
    c = Checks()
    trace_keys = ("input_tokens", "output_tokens", "api_calls", "repair_attempts", "repair_succeeded")
    for row in task["seed"]:
        audit.log_event(
            decision=row["decision"],
            command=row.get("command", "seeded"),
            category=row.get("category", ""),
            ok=row.get("ok"),
            duration_ms=row.get("duration_ms"),
            trace={key: row[key] for key in trace_keys if key in row},
        )
    stats = audit.stats()
    for key, value in task["expect"].items():
        actual = stats.get(key)
        if isinstance(value, float):
            c.expect(
                actual is not None and abs(actual - value) < 1e-3,
                f"stats[{key!r}] = {actual!r}, expected {value!r}",
            )
        else:
            c.expect(actual == value, f"stats[{key!r}] = {actual!r}, expected {value!r}")
    return c.outcome(f"{stats.get('commands')} commands aggregated")


def _blank_literals(script: str) -> str:
    return re.sub(r'"((?:[^"\\]|\\.)*)"', '""', script)


def _handler_scripts(handler: str, value: str) -> list[str]:
    """The AppleScript a built-in handler builds for `value`, captured instead of run."""
    scripts: list[str] = []

    def capture(args, **kwargs):
        scripts.append(args[-1])
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    with patched((subprocess, "run", capture)):
        if handler == "spotify_play":
            asyncio.run(_REAL_HANDLERS["spotify_control"]({"command": f"play {value} on spotify"}))
        elif handler == "imessage":
            asyncio.run(_REAL_HANDLERS["send_message"]({"command": f"text 5551234567 saying {value}"}))
        elif handler == "contacts_lookup":
            main._lookup_contact_phone(value)
        else:
            raise ValueError(f"unknown handler {handler!r}")
    return scripts


def run_handler_injection(task: dict) -> tuple[bool, str]:
    """A crafted value must stay inside its string literal in a handler's script."""
    c = Checks()
    benign = _handler_scripts(task["handler"], task["benign"])
    crafted = _handler_scripts(task["handler"], task["crafted"])
    c.expect(benign and crafted, "the handler built no AppleScript")
    c.expect(
        [_blank_literals(s) for s in benign] == [_blank_literals(s) for s in crafted],
        "the crafted value changed the script's code outside string literals",
    )
    c.expect(
        all(task["payload_marker"] not in _blank_literals(s) for s in crafted),
        f"{task['payload_marker']!r} reached executable code",
    )
    return c.outcome(f"{len(crafted)} script(s); the value stayed inside its literal")


def run_audit_page(task: dict) -> tuple[bool, str]:
    c = Checks()
    client = TestClient(main.app, raise_server_exceptions=False)
    headers = auth_headers("valid")
    row_keys = set(task["expect_row_keys"])

    def get(params: dict) -> dict:
        response = client.get("/audit", headers=headers, params=params)
        body = _json_or_none(response) or {}
        c.expect(
            response.status_code == 200 and set(body) == {"entries", "next_before_id"},
            f"GET /audit {params} returned HTTP {response.status_code} with keys {sorted(body)}",
        )
        shapes = {tuple(sorted(entry)) for entry in body.get("entries") or []}
        c.expect(all(set(shape) == row_keys for shape in shapes), f"GET /audit {params} row keys {sorted(shapes)}")
        return body

    if task["scenario"] == "limit_is_clamped":
        conn = audit._connect()
        with conn:
            conn.executemany(
                "INSERT INTO audit (ts, command, decision) VALUES (?, ?, 'executed')",
                [(float(n), f"row {n}") for n in range(task["rows"])],
            )
        conn.close()
        first = get({"limit": 1000})
        entries = first.get("entries") or []
        c.expect(len(entries) == 200, f"limit=1000 returned {len(entries)} rows, expected the cap of 200")
        c.expect(
            bool(entries) and first.get("next_before_id") == entries[-1]["id"],
            f"next_before_id {first.get('next_before_id')!r} after a capped page",
        )
        if first.get("next_before_id") is not None:
            rest = get({"limit": 200, "before_id": first["next_before_id"]})
            remaining = rest.get("entries") or []
            c.expect(
                len(remaining) == task["rows"] - 200 and rest.get("next_before_id") is None,
                f"the last page had {len(remaining)} rows and next_before_id {rest.get('next_before_id')!r}",
            )
        smallest = get({"limit": 0})
        c.expect(len(smallest.get("entries") or []) == 1, "limit=0 was not raised to 1")
        return c.outcome(f"{task['rows']} rows, capped at 200 per page")

    ids = [
        audit.log_event(
            decision=row["decision"],
            command=row.get("command", "seeded"),
            category=row.get("category", ""),
            command_id=row.get("command_id"),
            action=row.get("action"),
        )
        for row in task["seed"]
    ]
    if not all(isinstance(row_id, int) for row_id in ids):
        return False, f"seed rows were not written: {ids}"
    for page in task["pages"]:
        params = {key: ids[value] if key == "before_id" else value for key, value in page["params"].items()}
        body = get(params)
        found = [ids.index(entry.get("id")) if entry.get("id") in ids else entry.get("id") for entry in body.get("entries") or []]
        c.expect(found == page["expect"], f"GET /audit {page['params']} returned seed rows {found}, expected {page['expect']}")
        next_row = body.get("next_before_id")
        next_row = ids.index(next_row) if next_row in ids else next_row
        c.expect(next_row == page["next"], f"GET /audit {page['params']} next_before_id is row {next_row}, expected {page['next']}")
    for check in task.get("expect_rows") or []:
        entries = get(check["params"]).get("entries") or []
        for key, value in check["fields"].items():
            c.expect(
                bool(entries) and entries[0].get(key) == value,
                f"GET /audit {check['params']}: {key} = {entries[0].get(key) if entries else None!r}, expected {value!r}",
            )
    return c.outcome(f"{len(task['pages'])} pages checked")


def run_event_bus(task: dict) -> tuple[bool, str]:
    c = Checks()
    bus = events.bus
    scenario = task["scenario"]

    async def cross_thread_order() -> str:
        per_thread = task["events_per_thread"]
        subscribers = [bus.subscribe()[0] for _ in range(2)]

        def publish(thread: int) -> None:
            for n in range(per_thread):
                bus.publish("script", thread=thread, n=n)

        threads = [threading.Thread(target=publish, args=(thread,)) for thread in range(2)]
        for thread in threads:
            thread.start()
        received = []
        for subscriber in subscribers:
            received.append(
                [await _bounded(subscriber.queue.get(), 2.0, "an event published on another thread") for _ in range(2 * per_thread)]
            )
        for thread in threads:
            thread.join(2.0)
        order = [event_id for event_id, _ in bus.buffered()]
        for records in received:
            ids = [event_id for event_id, _ in records]
            c.expect(ids == order, "a subscriber received events out of publish order")
            c.expect(ids == sorted(set(ids)), "event ids did not strictly increase")
            for thread in range(2):
                ns = [event["n"] for _, event in records if event["thread"] == thread]
                c.expect(ns == list(range(per_thread)), f"thread {thread}'s events arrived as {ns[:5]}…")
        c.expect(received[0] == received[1], "two subscribers saw different streams")
        return f"{2 * per_thread} events from 2 threads, in order"

    async def replay_within_boot() -> str:
        earlier = events.EventBus()
        # A boot that started ten seconds before this one.
        earlier.first_id = earlier._next_id = bus.first_id - 10_000_000
        for n in range(3):
            earlier.publish("command", n=n)
        for n in range(5):
            bus.publish("command", n=n)
        ids = [event_id for event_id, _ in bus.buffered()]
        cases = [
            (str(ids[1]), ids[2:]),
            (str(ids[-1]), []),
            (None, []),
            ("", []),
            (str(earlier.buffered()[-1][0]), []),
            (str(bus.first_id - 1), []),
            (str(ids[-1] + 1), []),
            ("12ab", []),
            ("-1", []),
        ]
        for last_event_id, expected in cases:
            subscriber, replay = bus.subscribe(last_event_id)
            bus.unsubscribe(subscriber)
            replayed = [event_id for event_id, _ in replay]
            c.expect(
                replayed == expected,
                f"Last-Event-ID {last_event_id!r} replayed {len(replayed)} events, expected {len(expected)}",
            )
        return f"{len(cases)} Last-Event-ID values"

    async def subscriber_cap() -> str:
        limit = task["max_subscribers"]
        subscribers = [bus.subscribe()[0] for _ in range(limit)]
        try:
            subscribers.append(bus.subscribe()[0])
            c.expect(False, f"subscriber {limit + 1} was accepted")
        except events.TooManySubscribers:
            pass
        bus.unsubscribe(subscribers.pop(0))
        try:
            subscribers.append(bus.subscribe()[0])
        except events.TooManySubscribers:
            c.expect(False, "a released subscriber slot could not be reused")
        for subscriber in subscribers:
            bus.unsubscribe(subscriber)
        c.expect(bus.subscriber_count() == 0, f"{bus.subscriber_count()} subscribers left after unsubscribing all")
        return f"capped at {limit}"

    async def overflow_drops_subscriber() -> str:
        bus.publish("command", n=-1)
        marker = bus.buffered()[-1][0]
        slow, _ = bus.subscribe()
        fast, _ = bus.subscribe()
        total = events.QUEUE_SIZE + 1
        kept_up = []
        for n in range(total):
            bus.publish("script", n=n)
            # Deliveries run on the loop: let them, then read like a live stream would.
            await asyncio.sleep(0)
            while not fast.queue.empty():
                kept_up.append(fast.queue.get_nowait()[1]["n"])
        c.expect(slow.closed and bus.subscriber_count() == 1, "a subscriber that stopped reading was not dropped")
        c.expect(not fast.closed and kept_up == list(range(total)), "a subscriber that kept up lost events or was dropped")
        # Reconnecting from the last event it had seen replays everything it missed.
        again, replay = bus.subscribe(str(marker))
        bus.unsubscribe(again)
        missed = [event["n"] for _, event in replay]
        c.expect(
            missed == list(range(total)),
            f"reconnecting after the drop replayed {len(missed)} of the {total} events missed",
        )
        return f"dropped after {total} unread events"

    async def ring_buffer() -> str:
        size = task["buffer_size"]
        for n in range(size + 5):
            bus.publish("script", n=n)
        kept = [event["n"] for _, event in bus.buffered()]
        c.expect(kept == list(range(5, size + 5)), f"buffer kept {len(kept)} events from n={kept[:1]}")
        return f"kept the last {size}"

    scenarios = {
        "cross_thread_order": cross_thread_order,
        "replay_within_boot": replay_within_boot,
        "subscriber_cap": subscriber_cap,
        "overflow_drops_subscriber": overflow_drops_subscriber,
        "ring_buffer": ring_buffer,
    }
    if scenario not in scenarios:
        return False, f"unknown event_bus scenario {scenario!r}"
    return c.outcome(_run_async(scenarios[scenario]()))


def run_sse(task: dict) -> tuple[bool, str]:
    c = Checks()
    scenario = task["scenario"]
    token = security.get_token()

    async def connect(kind: str = "valid", last_event_id: str | None = None) -> AsgiCall:
        headers = dict(auth_headers(kind))
        if last_event_id is not None:
            headers["Last-Event-ID"] = last_event_id
        path = f"/events?token={token}" if kind == "query_param" else "/events"
        return await AsgiCall("GET", path, headers).start()

    async def expect_hello(stream: AsgiCall) -> dict:
        frame = _sse_frame(await stream.frame())
        data = _frame_data(frame)
        c.expect(
            frame["id"] is None and frame["event"] == "hello" and data.get("type") == "hello",
            f"the first frame was not hello: {frame['raw'][:120]!r}",
        )
        c.expect(
            set(data) == {"type", "ts", "boot_id", "server_time"} and data.get("boot_id") == events.bus.boot_id,
            f"hello data {data}",
        )
        return frame

    def announce(text: str) -> None:
        events.publish(
            "command", command_id="0" * 12, client_id=None, command=text, category="applescript_general", tier="act"
        )

    async def read_until(stream: AsgiCall, done) -> list[dict]:
        frames = []
        while True:
            frame = _sse_frame(await stream.frame())
            frames.append(frame)
            if not frame["raw"] or done(_frame_data(frame)):
                return frames

    async def requires_auth() -> str:
        for kind in task["auth_kinds"]:
            stream = await connect(kind)
            try:
                c.expect(stream.status == 401, f"GET /events with {kind} auth returned HTTP {stream.status}")
                if stream.status == 401:
                    body = await stream.json() or {}
                    c.expect("not paired" in str(body.get("error", "")), f"the 401 body was {body}")
                c.expect(events.bus.subscriber_count() == 0, f"a stream with {kind} auth took a subscriber slot")
            finally:
                await stream.close()
        return f"{len(task['auth_kinds'])} kinds of bad auth refused"

    async def command_lifecycle() -> str:
        current: dict = {}

        def generate(**kwargs):
            spec = current["generation"]
            return _fake_message(spec["script"], "generated", spec["input_tokens"], spec["output_tokens"])

        responses: dict = {}
        stream = await connect()
        try:
            c.expect(
                stream.status == 200 and stream.headers.get("content-type", "").startswith("text/event-stream"),
                f"GET /events returned HTTP {stream.status} as {stream.headers.get('content-type')!r}",
            )
            c.expect(stream.headers.get("cache-control") == "no-store", f"Cache-Control {stream.headers.get('cache-control')!r}")
            frames = [await expect_hello(stream)]
            with patched(
                (main.claude.messages, "create", generate),
                (applescript_validate.anthropic, "Anthropic", lambda *a, **k: _fake_anthropic(current.get("repair"))()),
                (subprocess, "run", lambda args, **kwargs: types.SimpleNamespace(returncode=0, stdout="", stderr="")),
            ):
                for spec in task["commands"]:
                    current.clear()
                    current.update(spec)
                    body = {"command": spec["command"], "client_id": spec["client_id"]}
                    responses[spec["client_id"]] = await AsgiCall("POST", "/text-command", auth_headers("valid"), body).json(5.0) or {}
            body = {"command": task["parked_command"], "client_id": "sse-parked"}
            parked = await AsgiCall("POST", "/text-command", auth_headers("valid"), body).json() or {}
            path = f"/pending/{parked.get('pending_id', 'missing')}"
            cancelled = await AsgiCall("DELETE", path, auth_headers("valid")).json() or {}
            c.expect(cancelled.get("cancelled") is True, f"cancel returned {cancelled}")
            frames += await read_until(
                stream, lambda data: data.get("type") == "cancelled" and data.get("client_id") == "sse-parked"
            )
        finally:
            await stream.close()

        c.expect(not [frame for frame in frames if token in frame["raw"]], "the pairing token appeared in the event stream")
        last_id = 0
        seen: dict = {}
        for frame in frames[1:]:
            if frame["comments"] and not frame["data_lines"]:
                continue
            data = _frame_data(frame)
            kind = data.get("type")
            frame_id = int(frame["id"]) if (frame["id"] or "").isdigit() else -1
            c.expect(frame_id > last_id, f"frame id {frame['id']!r} does not follow {last_id}")
            last_id = max(last_id, frame_id)
            c.expect(
                frame["event"] == kind and frame["data_lines"] == 1 and not frame["other"],
                f"malformed frame {frame['raw'][:120]!r}",
            )
            c.expect(
                set(data) == {"type", "ts"} | EVENT_FIELDS.get(kind, {"unknown event type"}) and isinstance(data.get("ts"), float),
                f"{kind} event fields {sorted(data)}",
            )
            seen.setdefault(data.get("client_id"), []).append(data)
        for spec in task["commands"]:
            response = responses.get(spec["client_id"], {})
            received = seen.get(spec["client_id"], [])
            kinds = [event["type"] for event in received]
            c.expect(kinds == spec["expect_events"], f"{spec['client_id']}: events {kinds}, expected {spec['expect_events']}")
            c.expect(
                all(event.get("command_id") == response.get("command_id") for event in received),
                f"{spec['client_id']}: events carry a command_id other than the response's",
            )
            finished = [event for event in received if event["type"] == "finished"][-1:] or [{}]
            for key in ("ok", "duration_ms", "audit_id"):
                c.expect(
                    finished[0].get(key) == response.get(key),
                    f"{spec['client_id']}: finished {key} {finished[0].get(key)!r}, response {response.get(key)!r}",
                )
            for key, value in spec["expect_finished"].items():
                c.expect(finished[0].get(key) == value, f"{spec['client_id']}: finished {key} {finished[0].get(key)!r}, expected {value!r}")
        parked_kinds = [event["type"] for event in seen.get("sse-parked", [])]
        c.expect(parked_kinds == ["command", "pending", "cancelled"], f"parked command events {parked_kinds}")
        return f"{len(frames)} frames"

    async def replay() -> str:
        for n in range(3):
            announce(f"buffered {n}")
        ids = [event_id for event_id, _ in events.bus.buffered()]
        stream = await connect(last_event_id=str(ids[0]))
        try:
            await expect_hello(stream)
            announce("live")
            live_id = events.bus.buffered()[-1][0]
            frames = await read_until(stream, lambda data: data.get("command") == "live")
        finally:
            await stream.close()
        c.expect(
            [frame["id"] for frame in frames] == [str(event_id) for event_id in ids[1:] + [live_id]],
            f"after Last-Event-ID {ids[0]} the stream sent ids {[frame['id'] for frame in frames]}",
        )
        c.expect(
            [_frame_data(frame).get("command") for frame in frames] == ["buffered 1", "buffered 2", "live"],
            "the replay sent the wrong events, or repeated one live",
        )
        # An id from an earlier boot, one this boot never issued, or garbage replays nothing.
        for stale in (str(events.bus.first_id - 1), str(ids[-1] + 10**6), "not-an-id"):
            stream = await connect(last_event_id=stale)
            try:
                await expect_hello(stream)
                announce(f"after {stale}")
                following = _sse_frame(await stream.frame())
            finally:
                await stream.close()
            c.expect(
                _frame_data(following).get("command") == f"after {stale}",
                f"Last-Event-ID {stale!r} replayed {following['raw'][:80]!r}",
            )
        return "replayed within the boot only"

    async def subscriber_slots() -> str:
        limit = task["max_subscribers"]
        streams: list[AsgiCall] = []
        try:
            for _ in range(limit):
                streams.append(await connect())
                await expect_hello(streams[-1])
            extra = await connect()
            streams.append(extra)
            c.expect(extra.status == 429, f"stream {limit + 1} returned HTTP {extra.status}, expected 429")
            if extra.status == 429:
                c.expect("error" in (await extra.json() or {}), "the 429 response has no error message")
            await streams[0].close()
            count = events.bus.subscriber_count()
            c.expect(count == limit - 1, f"{count} subscribers after one stream disconnected")
            streams.append(await connect())
            c.expect(streams[-1].status == 200, f"a freed slot was refused with HTTP {streams[-1].status}")
        finally:
            for stream in streams:
                await stream.close()
        count = events.bus.subscriber_count()
        c.expect(count == 0, f"{count} subscribers left after every stream disconnected")
        return f"{limit} streams, then 429"

    async def heartbeat() -> str:
        with patched((events, "HEARTBEAT_SECONDS", task["heartbeat_seconds"])):
            stream = await connect()
            try:
                await expect_hello(stream)
                frame = _sse_frame(await stream.frame())
            finally:
                await stream.close()
        c.expect(frame["raw"] == ": ping", f"an idle stream sent {frame['raw'][:80]!r}, expected a ping comment")
        return "ping sent while idle"

    scenarios = {
        "requires_auth": requires_auth,
        "command_lifecycle": command_lifecycle,
        "replay": replay,
        "subscriber_slots": subscriber_slots,
        "heartbeat": heartbeat,
    }
    if scenario not in scenarios:
        return False, f"unknown sse scenario {scenario!r}"
    return c.outcome(_run_async(scenarios[scenario]()))


def run_worker(task: dict) -> tuple[bool, str]:
    c = Checks()
    headers = auth_headers("valid")
    scenario = task["scenario"]

    def recorded(cmd: str) -> dict:
        return {"transcript": cmd, "action": "recorded", "osascript_ok": True}

    async def one_at_a_time() -> str:
        first, second = task["commands"]
        release = threading.Event()
        lock = threading.Lock()
        active = {"now": 0, "max": 0}
        runs: list[tuple] = []

        async def handler(data, cmd):
            with lock:
                active["now"] += 1
                active["max"] = max(active["max"], active["now"])
            began = time.monotonic()
            if cmd == first:
                # Hold the worker until the second command has been handed over.
                release.wait(task["hold_seconds"])
            with lock:
                active["now"] -= 1
                runs.append((threading.current_thread().name, began, time.monotonic()))
            return recorded(cmd)

        calls: list[AsgiCall] = []
        with patched((main, "_run_text_command", handler)):
            try:
                calls.append(AsgiCall("POST", "/text-command", headers, {"command": first}).begin())
                await _until(lambda: _published("started"), 2.0, "the first command started")
                calls.append(AsgiCall("POST", "/text-command", headers, {"command": second}).begin())
                await _until(lambda: len(_published("command")) == 2, 2.0, "the second command arrived")
                release.set()
                bodies = [await call.json(5.0) or {} for call in calls]
            finally:
                release.set()
                for call in calls:
                    await call.close()
        c.expect(all(body.get("ok") is True for body in bodies), f"responses {bodies}")
        threads = [name for name, _, _ in runs]
        c.expect(
            len(runs) == 2 and len(set(threads)) == 1 and threads[0].startswith("imperium-command"),
            f"commands ran on threads {threads}",
        )
        c.expect(active["max"] == 1, f"{active['max']} commands ran at once")
        spans = sorted((began, ended) for _, began, ended in runs)
        c.expect(len(spans) == 2 and spans[0][1] <= spans[1][0], "the second command started before the first finished")
        lifecycle = [event["type"] for event in _published() if event["type"] in ("started", "finished")]
        c.expect(
            lifecycle == ["started", "finished", "started", "finished"],
            f"a queued command was reported started early: {lifecycle}",
        )
        return f"two commands, one at a time on {threads[:1]}"

    async def stays_responsive() -> str:
        entered, release = threading.Event(), threading.Event()
        outcome: dict = {}

        async def handler(data, cmd):
            entered.set()
            outcome["released"] = release.wait(task["hold_seconds"])
            return recorded(cmd)

        calls: list[AsgiCall] = []
        with patched((main, "_run_text_command", handler)):
            try:
                parked = await AsgiCall("POST", "/text-command", headers, {"command": task["parked_command"]}).json() or {}
                stream = await AsgiCall("GET", "/events", headers).start()
                calls.append(stream)
                c.expect(_sse_frame(await stream.frame())["event"] == "hello", "the stream did not open with hello")
                held = AsgiCall("POST", "/text-command", headers, {"command": task["command"], "client_id": "held"})
                calls.append(held.begin())
                while True:
                    data = _frame_data(_sse_frame(await stream.frame()))
                    if data.get("type") == "started" and data.get("client_id") == "held":
                        break
                listing = await AsgiCall("GET", "/pending", headers).json() or {}
                path = f"/pending/{parked.get('pending_id', 'missing')}"
                cancelled = await AsgiCall("DELETE", path, headers).json() or {}
                page = await AsgiCall("GET", "/audit?limit=5", headers).json() or {}
                answered_while_running = entered.is_set() and "released" not in outcome
                release.set()
                body = await held.json(5.0) or {}
            finally:
                release.set()
                for call in calls:
                    await call.close()
        c.expect(
            answered_while_running,
            "the event stream, GET /pending, DELETE /pending, and GET /audit waited for the running command",
        )
        listed = [entry.get("pending_id") for entry in listing.get("pending", [])]
        c.expect(listed == [parked.get("pending_id")], f"GET /pending during the command listed {listed}")
        c.expect(cancelled.get("cancelled") is True, f"DELETE /pending during the command returned {cancelled}")
        c.expect(isinstance(page.get("entries"), list), f"GET /audit during the command returned {page}")
        c.expect(
            body.get("ok") is True and outcome.get("released") is True,
            f"the held command did not finish cleanly: {body}",
        )
        return "the server answered while a command ran"

    def keeps_context() -> str:
        client = TestClient(main.app, raise_server_exceptions=False)
        seen: list[dict] = []

        async def handler(data, cmd):
            trace = tracing.current() or {}
            seen.append(
                {
                    "confirmed": permissions.is_confirmed(),
                    "command_id": trace.get("command_id"),
                    "client_id": trace.get("client_id"),
                    "thread": threading.current_thread().name,
                }
            )
            tracing.record_usage(_fake_message("", "", task["input_tokens"], task["output_tokens"]), model="fake-model")
            tracing.record_script(task["script"])
            return recorded(cmd)

        with patched((main, "_run_text_command", handler)):
            body = {"command": task["parked_command"], "client_id": "ctx"}
            parked = _json_or_none(client.post("/text-command", headers=headers, json=body)) or {}
            path = f"/confirm/{parked.get('pending_id', 'missing')}"
            result = _json_or_none(client.post(path, headers=headers)) or {}
            plain = _json_or_none(client.post("/text-command", headers=headers, json={"command": task["command"]})) or {}
        command_id = parked.get("command_id")
        c.expect(len(seen) == 2, f"the handler ran {len(seen)} times, expected 2")
        if len(seen) == 2:
            confirmed, unconfirmed = seen
            c.expect(confirmed["confirmed"] is True, "the confirmed command lost its confirmation on the worker")
            c.expect(
                confirmed["command_id"] == command_id and confirmed["client_id"] == "ctx",
                f"the worker's trace belonged to {confirmed['command_id']!r} / {confirmed['client_id']!r}",
            )
            c.expect(
                unconfirmed["confirmed"] is False and unconfirmed["command_id"] == plain.get("command_id"),
                f"the next command on the worker inherited the previous one's state: {unconfirmed}",
            )
            c.expect(
                confirmed["thread"] == unconfirmed["thread"] and confirmed["thread"].startswith("imperium-command"),
                f"commands ran on {confirmed['thread']!r} and {unconfirmed['thread']!r}",
            )
        c.expect(result.get("command_id") == command_id, f"confirm returned command_id {result.get('command_id')!r}")
        rows = audit.page(5, decision="executed", command_id=command_id)["entries"]
        row = rows[0] if rows else {}
        expected = {
            "input_tokens": task["input_tokens"],
            "output_tokens": task["output_tokens"],
            "api_calls": 1,
            "models": "fake-model",
            "script": task["script"],
        }
        for key, value in expected.items():
            c.expect(row.get(key) == value, f"audit {key} = {row.get(key)!r}, expected {value!r}")
        for kind in ("model_call", "script"):
            c.expect(
                len(_published(kind, command_id=command_id, client_id="ctx")) == 1,
                f"no {kind} event carries the confirmed command's ids",
            )
        return "confirmation and trace carried onto the worker"

    if scenario == "one_at_a_time":
        return c.outcome(_run_async(one_at_a_time()))
    if scenario == "stays_responsive":
        return c.outcome(_run_async(stays_responsive()))
    if scenario == "keeps_context":
        return c.outcome(keeps_context())
    return False, f"unknown worker scenario {scenario!r}"


# Fixture pages for the /app host: markup strings, and (open tag, script text as
# written, whether a browser runs it[, close tag]) tuples. The CSP hashes a page
# needs come from these declarations, never from the tokenizer under test.
EXPORT_INDEX = [
    '<!DOCTYPE html>\r\n<html lang="en"><head><meta charset="utf-8">\r\n',
    "<title>Imperium <script>window.__IN_TITLE__=1</script></title>\r\n",
    ("<script>", "self.__next_f=self.__next_f||[];self.__next_f.push([0])", True),
    ('<script src="/app/_next/static/chunks/main-abc123.js" async="">', "window.__IGNORED_FOR_SRC__=1", False),
    ('<script type="application/json" id="__NEXT_DATA__">', '{"props":{"pageProps":{}},"page":"/"}', False),
    "<!-- <script>window.__IN_COMMENT__=1</script> -->\r\n",
    ("<script>", 'self.__next_f.push([1,"crlf"])\r\nwindow.__CRLF__="</scripts>"\r\n', True),
    ('<SCRIPT TYPE="module">', 'import("/app/_next/static/chunks/main-abc123.js")', True, "</SCRIPT >"),
    ('<script data-note="a > b" type=" text/javascript ">', "window.__ATTRIBUTE_WITH_GT__=1", True),
    ("<script>", '\n<!--\ndocument.write("<script>window.__NESTED__=1</script>");\n-->\n', True),
    ('<script type="text/plain">', "window.__PLAIN_TEXT__=1", False),
    # The spec strips the type before comparing it, so an empty or whitespace-only
    # one is the empty string, which runs — and a padded language still names one.
    ('<script type="">', "window.__EMPTY_TYPE__=1", True),
    ('<script type="  \t ">', "window.__BLANK_TYPE__=1", True),
    ('<script language=" javascript ">', "window.__PADDED_LANGUAGE__=1", True),
    ('<script language="vbscript">', "MsgBox 1", False),
    "<textarea><script>window.__IN_TEXTAREA__=1</script></textarea>\r\n",
    "<noscript><script>window.__IN_NOSCRIPT__=1</script></noscript>\r\n",
    ("<script>", "", False),
    ("<script>", "self.__next_f=self.__next_f||[];self.__next_f.push([0])", True),
    "</head><body><main>Imperium</main></body></html>\r\n",
]
EXPORT_ACTIVITY = [
    "<!doctype html><html><head>",
    ("<script>", 'self.__next_f.push([2,"activity"])', True),
    "</head><body>Activity</body></html>",
]
EXPORT_404 = [
    "<!doctype html><html><head><title>Not found</title>",
    ("<script>", 'self.__next_f.push([3,"not found"])', True),
    "</head><body>Not found</body></html>",
]
EXPORT_INDEX_REBUILT = [
    "<!doctype html><html><head>",
    ("<script>", 'self.__next_f.push([4,"rebuilt with a longer script"])', True),
    "</head><body>Rebuilt</body></html>",
]


def _write_export_page(path: Path, parts: list) -> list[str]:
    """Write a fixture page; returns the CSP sources its running scripts need, without repeats."""
    markup: list[str] = []
    sources: list[str] = []
    for part in parts:
        if isinstance(part, str):
            markup.append(part)
            continue
        open_tag, text, runs = part[:3]
        markup.append(f"{open_tag}{text}{part[3] if len(part) > 3 else '</script>'}\r\n")
        if runs and text:
            # A browser hashes the text after normalizing its newlines.
            digest = hashlib.sha256(text.replace("\r\n", "\n").encode("utf-8")).digest()
            source = f"'sha256-{base64.b64encode(digest).decode('ascii')}'"
            if source not in sources:
                sources.append(source)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes("".join(markup).encode("utf-8"))
    return sources


def _csp_directives(policy: str) -> dict:
    directives: dict = {}
    for directive in policy.split(";"):
        tokens = directive.split()
        if tokens:
            directives.setdefault(tokens[0].lower(), tokens[1:])
    return directives


def run_frontend_host(task: dict) -> tuple[bool, str]:
    c = Checks()
    client = TestClient(main.app, raise_server_exceptions=False, follow_redirects=False)
    root = main.frontend.directory
    html_cache = task["cache"]["html"]

    def fetch(method: str, path: str, status: int, script_sources=(), cache: str = html_cache):
        response = client.request(method, path)
        label = f"{method} {path}"
        c.expect(response.status_code == status, f"{label} returned HTTP {response.status_code}, expected {status}")
        for name, value in task["expect_headers"].items():
            c.expect(response.headers.get(name) == value, f"{label}: {name} = {response.headers.get(name)!r}, expected {value!r}")
        csp = _csp_directives(response.headers.get("content-security-policy", ""))
        for name, value in task["expect_csp"].items():
            c.expect(csp.get(name) == value.split(), f"{label}: CSP {name} {csp.get(name)}, expected {value!r}")
        script_src = csp.get("script-src", [])
        c.expect(
            not {"'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'"} & {source.lower() for source in script_src},
            f"{label}: script-src allows unsafe sources: {script_src}",
        )
        c.expect(
            sorted(script_src) == sorted(["'self'", *script_sources]),
            f"{label}: script-src {script_src}, expected 'self' and the {len(script_sources)} hashes of its running scripts",
        )
        c.expect(
            response.headers.get("cache-control") == cache,
            f"{label}: Cache-Control {response.headers.get('cache-control')!r}, expected {cache!r}",
        )
        return response

    if task["scenario"] == "export":
        index = _write_export_page(root / "index.html", EXPORT_INDEX)
        activity = _write_export_page(root / "activity" / "index.html", EXPORT_ACTIVITY)
        not_found = _write_export_page(root / "404.html", EXPORT_404)
        chunk = root / "_next" / "static" / "chunks" / "main-abc123.js"
        chunk.parent.mkdir(parents=True)
        chunk.write_text("console.log('chunk')\n")
        c.expect("Imperium" in fetch("GET", "/app/", 200, index).text, "the export's index page was not served")
        fetch("HEAD", "/app/", 200, index)
        fetch("GET", "/app/activity/", 200, activity)
        fetch("GET", "/app/nowhere/", 404, not_found)
        fetch("GET", "/app/_next/static/chunks/missing-000.js", 404, not_found)
        fetch("GET", "/app/_next/static/chunks/main-abc123.js", 200, (), task["cache"]["hashed_asset"])
        fetch("POST", "/app/", 405)
        for path, location in (("/app", "/app/"), ("/app/activity", "/app/activity/")):
            response = fetch("GET", path, 307)
            c.expect(
                response.headers.get("location", "").endswith(location),
                f"GET {path} redirected to {response.headers.get('location')!r}",
            )
        # A rebuilt page gets the hashes of its new scripts, not the cached ones.
        rebuilt = _write_export_page(root / "index.html", EXPORT_INDEX_REBUILT)
        c.expect("Rebuilt" in fetch("GET", "/app/", 200, rebuilt).text, "the rebuilt index page was not served")
        return c.outcome(f"{len(index)} running inline scripts hashed")

    if task["scenario"] == "fallback":
        c.expect(not root.exists(), f"the task's export directory {root} already exists")
        pages = (
            ("GET", "/app/", 200), ("HEAD", "/app/", 200), ("GET", "/app/index.html", 200),
            ("GET", "/app/audit/", 404), ("GET", "/app/_next/static/chunks/main.js", 404),
        )
        for method, path, status in pages:
            response = fetch(method, path, status)
            if method == "GET":
                c.expect(task["fallback_contains"] in response.text, f"{method} {path} did not serve the build instructions")
        c.expect(fetch("GET", "/app", 307).headers.get("location") == "/app/", "GET /app did not redirect to /app/")
        # Building the export takes effect without restarting the backend.
        built = _write_export_page(root / "index.html", EXPORT_ACTIVITY)
        page = fetch("GET", "/app/", 200, built)
        c.expect(task["fallback_contains"] not in page.text, "the fallback was still served after the export was built")
        return c.outcome("fallback served under the same headers")

    return False, f"unknown frontend_host scenario {task['scenario']!r}"


def run_token_storage(task: dict) -> tuple[bool, str]:
    c = Checks()
    token = security.get_token()
    file_mode = security.TOKEN_FILE.stat().st_mode & 0o777
    dir_mode = security.IMPERIUM_DIR.stat().st_mode & 0o777
    c.expect(file_mode == 0o600, f"token file mode {oct(file_mode)}, expected 0o600")
    c.expect(dir_mode == 0o700, f"state directory mode {oct(dir_mode)}, expected 0o700")
    c.expect(len(token) >= task.get("min_length", 43), f"token only {len(token)} characters")
    security._token_cache = None
    c.expect(security.get_token() == token, "token changed after a restart")
    return c.outcome(f"mode {oct(file_mode)}, {len(token)} chars, persistent")


def _recorded(command: str) -> dict:
    return {"transcript": command, "action": "recorded", "osascript_ok": True}


def _encodes(text: str) -> bool:
    """Whether the text survives the UTF-8 encode every JSON response and the audit write do."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def run_robustness(task: dict) -> tuple[bool, str]:
    """Malformed or hostile input answers the contract instead of raising a 500."""
    c = Checks()
    headers = auth_headers("valid")
    client = TestClient(main.app, raise_server_exceptions=False)
    scenario = task["scenario"]

    async def handler(data, command):
        return _recorded(command)

    if scenario == "unencodable_command":
        # A lone surrogate is legal JSON but cannot be encoded to UTF-8: it must
        # never reach the audit write, the parked entry, or a JSON response.
        healthy = client.post("/text-command", headers=headers, json={"command": task["healthy_command"]})
        c.expect(healthy.status_code == 200, f"the healthy command returned HTTP {healthy.status_code}")
        response = client.post(
            "/text-command",
            headers=dict(headers, **{"Content-Type": "application/json"}),
            content=task["raw_body"].encode("utf-8"),
        )
        c.expect(response.status_code == 200, f"the malformed command returned HTTP {response.status_code}")
        body = _json_or_none(response) or {}
        c.expect(body.get("requires_confirmation") is True, f"the command was not parked: {body}")
        command = str(body.get("command", ""))
        c.expect(_encodes(command), f"the parked command still cannot be encoded: {command!r}")
        c.expect(
            all(_encodes(str(row.get("value", ""))) for row in body.get("details") or []),
            f"a detail row still cannot be encoded: {body.get('details')}",
        )
        listing = client.get("/pending", headers=headers)
        c.expect(listing.status_code == 200, f"GET /pending afterwards returned HTTP {listing.status_code}")
        listed = [entry.get("pending_id") for entry in (_json_or_none(listing) or {}).get("pending", [])]
        c.expect(len(listed) == 2, f"GET /pending listed {listed}, expected both parked commands")
        page = client.get("/audit", headers=headers)
        c.expect(page.status_code == 200, f"GET /audit afterwards returned HTTP {page.status_code}")
        decisions = [entry["decision"] for entry in (_json_or_none(page) or {}).get("entries", [])]
        c.expect(decisions.count("pending_confirmation") == 2, f"audit recorded {decisions}")
        return c.outcome("the command was repaired at the door")

    if scenario == "oversized_command":
        # _pending_details runs on the event loop, and the handlers' parsers are
        # not linear in what they scan: a huge command must not stall the server.
        command = task["prefix"] + task["filler"] * task["filler_chars"] + task["suffix"]
        began = time.monotonic()
        response = client.post("/text-command", headers=headers, json={"command": command})
        elapsed = time.monotonic() - began
        c.expect(response.status_code == 200, f"HTTP {response.status_code}")
        body = _json_or_none(response) or {}
        c.expect(body.get("requires_confirmation") is True, f"the command was not parked: {sorted(body)}")
        sizes = [len(str(row.get("value", ""))) for row in body.get("details") or []]
        c.expect(
            sizes and max(sizes) <= main.DETAILS_PREVIEW_CHARS,
            f"detail values are {sizes} characters, expected at most {main.DETAILS_PREVIEW_CHARS}",
        )
        c.expect(elapsed < task["max_seconds"], f"parking took {elapsed:.2f}s, expected under {task['max_seconds']}s")
        return c.outcome(f"parked in {elapsed * 1000:.0f} ms, details {sizes}")

    if scenario == "audit_unavailable":
        # audit.py's contract: a write that cannot happen never breaks the action.
        def unavailable(*args, **kwargs):
            raise OSError(28, "No space left on device")

        with patched((audit, "_connect", unavailable), (main, "_run_text_command", handler)):
            response = client.post("/text-command", headers=headers, json={"command": task["command"]})
            c.expect(response.status_code == 200, f"POST /text-command returned HTTP {response.status_code}")
            body = _json_or_none(response) or {}
            c.expect(body.get("ok") is True, f"the command did not succeed: {body}")
            c.expect("audit_id" in body and body["audit_id"] is None, f"audit_id is {body.get('audit_id')!r}")
            kinds = [event["type"] for event in _published(command_id=body.get("command_id"))]
            c.expect(kinds[-1:] == ["finished"], f"the command's events were {kinds}, expected to end in finished")
            stats = client.get("/stats", headers=headers)
            c.expect(stats.status_code == 200, f"GET /stats returned HTTP {stats.status_code}")
            c.expect((_json_or_none(stats) or {}).get("commands") == 0, "GET /stats did not fall back to an empty log")
            page = client.get("/audit", headers=headers)
            c.expect(page.status_code == 200, f"GET /audit returned HTTP {page.status_code}")
            c.expect((_json_or_none(page) or {}) == {"entries": [], "next_before_id": None}, "GET /audit did not fall back")
        return c.outcome("the command, its events, and the read routes survived")

    return False, f"unknown robustness scenario {scenario!r}"


def run_raw_request(task: dict) -> tuple[bool, str]:
    """Requests TestClient cannot express: raw header bytes, NUL paths, websockets."""
    c = Checks()
    scenario = task["scenario"]

    if scenario == "non_ascii_auth_header":
        # Header values decode as latin-1, so a byte >= 0x80 gives a non-ASCII
        # str — which hmac.compare_digest refuses. That must still be a 401.
        async def probe() -> str:
            for value in task["headers"]:
                call = AsgiCall(task["method"], task["path"], {"Authorization": value})
                body = await call.json() or {}
                label = f"Authorization: {value!r}"
                c.expect(call.status == 401, f"{label}: HTTP {call.status}, expected 401")
                c.expect("not paired" in str(body.get("error", "")).lower(), f"{label}: body {body}")
                for name, expected in task["expect_headers"].items():
                    c.expect(call.headers.get(name.lower()) == expected, f"{label}: {name} = {call.headers.get(name.lower())!r}")
            return f"{len(task['headers'])} malformed Authorization values answered 401"

        return c.outcome(_run_async(probe()))

    if scenario == "unrepresentable_path":
        # uvicorn percent-decodes the target, so GET /app/%00 arrives as a path
        # os.stat cannot express. Starlette does not catch that, so the mount must.
        _write_export_page(main.frontend.directory / "index.html", EXPORT_ACTIVITY)

        async def probe() -> str:
            for path in task["paths"]:
                call = AsgiCall("GET", path)
                await call.json()
                label = f"GET {path!r}"
                c.expect(call.status == 404, f"{label}: HTTP {call.status}, expected 404")
                for name, expected in task["expect_headers"].items():
                    c.expect(call.headers.get(name.lower()) == expected, f"{label}: {name} = {call.headers.get(name.lower())!r}")
                c.expect(
                    "frame-ancestors 'none'" in call.headers.get("content-security-policy", ""),
                    f"{label}: CSP is {call.headers.get('content-security-policy')!r}",
                )
            return f"{len(task['paths'])} unrepresentable paths answered a secured 404"

        return c.outcome(_run_async(probe()))

    if scenario == "websocket_refused":
        # Starlette routes websocket scopes to a mount too, and the HTTP auth
        # middleware never sees them: the mount must close the handshake itself.
        async def probe() -> str:
            for path in task["paths"]:
                sent: list[dict] = []

                async def receive():
                    return {"type": "websocket.connect"}

                async def send(message):
                    sent.append(message)

                scope = {
                    "type": "websocket",
                    "asgi": {"version": "3.0", "spec_version": "2.3"},
                    "path": path,
                    "raw_path": path.encode(),
                    "query_string": b"",
                    "root_path": "",
                    "scheme": "ws",
                    "headers": [(b"host", b"testserver")],
                    "client": ("127.0.0.1", 50000),
                    "server": ("testserver", 80),
                    "subprotocols": [],
                }
                await _bounded(main.app(scope, receive, send), 2.0, f"the websocket to {path} did not finish")
                kinds = [message["type"] for message in sent]
                c.expect(
                    kinds[:1] == ["websocket.close"],
                    f"a websocket to {path} was answered with {kinds}, expected websocket.close",
                )
            return f"{len(task['paths'])} websocket handshakes refused"

        return c.outcome(_run_async(probe()))

    return False, f"unknown raw_request scenario {scenario!r}"


# --- Live executor ----------------------------------------------------------

OUTWARD_FACING = re.compile(
    r"\b(send|e-?mail|imessage|text\s+(?:to|message)|push|commit|delete|remove|trash|"
    r"quit|close\s+(?:all|everything)|shut\s*down|restart|log\s*out)\b",
    re.IGNORECASE,
)


def osascript(script: str, timeout: float = 15.0) -> str:
    result = subprocess.run(
        ["osascript", "-e", script], capture_output=True, text=True, timeout=timeout
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "osascript failed")
    return result.stdout.strip()


def live_preflight() -> str | None:
    if sys.platform != "darwin":
        return "the live suite requires macOS"
    if not os.getenv("ANTHROPIC_API_KEY"):
        return "ANTHROPIC_API_KEY is not set (add it to backend/.env)"
    try:
        osascript(
            'tell application "System Events" to get name of first application process '
            "whose frontmost is true"
        )
    except Exception as e:
        return (
            "osascript cannot query System Events — grant Automation and Accessibility "
            f"permission to your terminal ({e})"
        )
    return None


def run_live(task: dict) -> tuple[bool, str]:
    command = task["command"]
    category = main._classify_command(command)
    if permissions.tier_for(category) == "destructive" or OUTWARD_FACING.search(command):
        raise Refused(f"refused to run {command!r} live: outward-facing or destructive ({category})")

    c = Checks()
    try:
        for script in task.get("setup") or []:
            osascript(script)
            time.sleep(0.5)

        client = TestClient(main.app, raise_server_exceptions=False)
        response = client.post(
            "/text-command", headers=auth_headers("valid"), json={"command": command}
        )
        body = _json_or_none(response) or {}
        c.expect(response.status_code == 200, f"HTTP {response.status_code}")
        c.expect(not body.get("requires_confirmation"), "command was parked for confirmation")
        failed = bool(body.get("error")) or body.get("osascript_ok") is False
        if task.get("expect_failure"):
            c.expect(failed, f"expected a graceful failure, got {body.get('action')!r}")
        else:
            c.expect(
                not failed,
                f"agent reported failure: {body.get('error') or body.get('osascript_error')}",
            )

        time.sleep(task.get("settle_seconds", 2.0))
        verify = task.get("verify")
        if verify:
            try:
                observed = osascript(verify["osascript"])
            except Exception as e:
                c.expect(False, f"verification query failed: {e}")
            else:
                if "equals" in verify:
                    c.expect(observed == str(verify["equals"]), f"observed {observed!r}, expected {verify['equals']!r}")
                if "contains" in verify:
                    c.expect(
                        str(verify["contains"]).lower() in observed.lower(),
                        f"observed {observed!r}, expected it to contain {verify['contains']!r}",
                    )
                if "regex" in verify:
                    c.expect(
                        re.search(verify["regex"], observed, re.IGNORECASE),
                        f"observed {observed!r}, expected /{verify['regex']}/",
                    )
    finally:
        for script in task.get("teardown") or []:
            with contextlib.suppress(Exception):
                osascript(script)
    return c.outcome(task.get("expect", "verified"))


EXECUTORS = {
    "classify": run_classify,
    "policy": run_policy,
    "validate": run_validate,
    "http": run_http,
    "confirm_flow": run_confirm_flow,
    "retry": run_retry,
    "tracing": run_tracing,
    "migration": run_migration,
    "stats": run_stats,
    "audit_page": run_audit_page,
    "event_bus": run_event_bus,
    "sse": run_sse,
    "worker": run_worker,
    "frontend_host": run_frontend_host,
    "robustness": run_robustness,
    "raw_request": run_raw_request,
    "token_storage": run_token_storage,
    "handler_injection": run_handler_injection,
    "live": run_live,
}


# --- Mutation check ---------------------------------------------------------


def _replayable_pop(pending_id: str):
    permissions._prune()
    return permissions._pending.get(pending_id)


def _tell_application_only(script: str) -> list[str]:
    """The v2 Phase 1 allowlist check, which only recognised `tell application`."""
    return re.findall(r'\btell\s+app(?:lication)?\s+(?:process\s+)?"([^"]+)"', script, re.IGNORECASE)


_ORIGINAL_LEX = policy_gate._lex


def _lex_ignoring_comments(script: str) -> tuple[str, str]:
    """The first gate's view of a script: quotes paired with no knowledge of comments."""
    return script, re.sub(r'"((?:[^"\\]|\\.)*)"', '""', script)


def _lex_keeping_literals(script: str) -> tuple[str, str]:
    """A gate that forgets to blank string literals before matching."""
    code, _ = _ORIGINAL_LEX(script)
    return code, code


def _rounded_percentile(sorted_values: list[int], q: float) -> int | None:
    """The first percentile, which rounded an index instead of using nearest rank."""
    if not sorted_values:
        return None
    return sorted_values[max(0, min(len(sorted_values) - 1, int(round(q * (len(sorted_values) - 1)))))]


def _v3_columns_only_in_new_databases():
    """command_id and action added to CREATE TABLE, but never to an existing database."""
    schema = audit._SCHEMA.replace("duration_ms INTEGER\n", "duration_ms INTEGER,\n    command_id TEXT,\n    action TEXT\n")
    columns = [column for column in audit._ADDED_COLUMNS if column[0] not in ("command_id", "action")]
    return patched((audit, "_SCHEMA", schema), (audit, "_ADDED_COLUMNS", columns))


_ORIGINAL_QUERY = audit._query


def _query_ignoring_filters(limit, before_id=None, decision=None, command_id=None):
    return _ORIGINAL_QUERY(limit, before_id)


def _page_without_lookahead(limit=50, before_id=None, decision=None, command_id=None):
    """Pages of exactly `limit` rows, so a full last page still points past the end."""
    entries = audit._query(limit, before_id, decision, command_id)
    return {"entries": entries, "next_before_id": entries[-1]["id"] if entries and len(entries) == limit else None}


_ORIGINAL_IS_PUBLIC = security._is_public


def _event_stream_public(path: str) -> bool:
    return path == "/events" or _ORIGINAL_IS_PUBLIC(path)


def _cancel_without_revoking(pending_id: str):
    """A cancel that reports the parked command but leaves it confirmable."""
    permissions._prune()
    return permissions._pending.get(pending_id)


def _list_pending_unpruned():
    return sorted(permissions._pending.items(), key=lambda item: item[1]["created_at"])


_ORIGINAL_DETAILS = main._pending_details


def _details_with_contact_lookup(category: str, command: str) -> list[dict]:
    """Details that resolve a named recipient's number up front, reading Contacts before Confirm."""
    parsed = main._parse_text_message(command)
    if category == "message_send" and parsed["recipient"] and not parsed["is_phone"]:
        main._lookup_contact_phone(parsed["recipient"])
    return _ORIGINAL_DETAILS(category, command)


async def _execute_on_event_loop(data, command, category, tier, command_id=None, client_id=None):
    """The v2 execution model: the whole command awaited on the event loop itself."""
    return await main._command(data, command, category, tier, command_id or main._new_command_id(), client_id)


def _replay_after_any_boot(self, last_event_id):
    """Replay that trusts any numeric Last-Event-ID, whichever boot issued it."""
    text = (last_event_id or "").strip()
    return int(text) if text.isdigit() else None


def _deliver_ignoring_overflow(self, subscriber, record):
    """Delivery that drops the event instead of the subscriber that stopped reading."""
    if not subscriber.closed:
        with contextlib.suppress(asyncio.QueueFull):
            subscriber.queue.put_nowait(record)


_ORIGINAL_HELLO = events.EventBus.hello


def _hello_with_pairing_url(self) -> dict:
    """A hello that offers the pairing URL, to help pair a second device."""
    return {**_ORIGINAL_HELLO(self), "pairing_url": f"http://127.0.0.1:8000/app#token={security.get_token()}"}


_ORIGINAL_CSP = frontend_host.content_security_policy


def _csp_allowing_inline_scripts(script_hashes=()) -> str:
    return _ORIGINAL_CSP(script_hashes).replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")


def _csp_without_frame_ancestors(script_hashes=()) -> str:
    return _ORIGINAL_CSP(script_hashes).replace("; frame-ancestors 'none'", "")


def _script_end_at_first_close(text: str, i: int) -> tuple[int, int]:
    """A tokenizer that ends script text at the first `</script`, ignoring the escaped states."""
    lt = text.lower().find("</script", i)
    if lt == -1:
        return len(text), len(text)
    return lt, frontend_host._after_tag(text, lt)


def _executes_without_stripping(attributes: dict) -> bool:
    """A scanner that tests the raw type and language, so padded values look unknown."""
    if "src" in attributes:
        return False
    if "type" in attributes:
        if attributes["type"] == "":
            return True
        type_string = attributes["type"].lower()
    elif attributes.get("language"):
        type_string = "text/" + attributes["language"].lower()
    else:
        return True
    return type_string in ("module", "importmap", "speculationrules") or type_string in frontend_host._JAVASCRIPT_TYPES


def _log_event_for_sqlite_errors_only(decision: str, **fields):
    """An audit writer that only survives sqlite3's own errors, as the first one did."""
    try:
        return audit._insert(decision, **fields)
    except sqlite3.Error:
        return None


def _token_matches_as_text(supplied: str) -> bool:
    """Comparing header text instead of bytes, which raises on any non-ASCII value."""
    return security.hmac.compare_digest(supplied, security.get_token())


MUTATIONS = [
    ("Auth middleware treats every path as public", lambda: patched((security, "_is_public", lambda path: True))),
    ("Token comparison accepts any token", lambda: patched((security.hmac, "compare_digest", lambda a, b: True))),
    ("Destructive actions skip confirmation", lambda: patched((permissions, "needs_confirmation", lambda tier: False))),
    ("Pending confirmations are replayable", lambda: patched((permissions, "pop_pending", _replayable_pop))),
    ("Pending confirmations never expire", lambda: patched((permissions, "PENDING_TTL_SECONDS", 10**9))),
    ("Policy gate allows every script", lambda: patched((policy_gate, "check_script", lambda script: (True, "")))),
    (
        "App allowlist is not enforced",
        lambda: patched((policy_gate, "_app_references", lambda s: []), (policy_gate, "_bundle_names", lambda s: [])),
    ),
    (
        "Allowlist only checks `tell application` (the Phase 1 gate)",
        lambda: patched((policy_gate, "_app_references", _tell_application_only), (policy_gate, "_bundle_names", lambda s: [])),
    ),
    (
        "Running strings as AppleScript not banned",
        lambda: patched((policy_gate, "_BANNED", [b for b in policy_gate._BANNED if "run|load|store" not in b[0]])),
    ),
    ("Mail and Messages sends skip confirmation", lambda: patched((permissions, "is_confirmed", lambda: True))),
    (
        "Confirm route does not mark commands confirmed",
        lambda: patched((permissions, "confirmed_context", contextlib.nullcontext)),
    ),
    ("Bans match inside quoted strings", lambda: patched((policy_gate, "_lex", _lex_keeping_literals))),
    ("Comments not understood by the policy gate", lambda: patched((policy_gate, "_lex", _lex_ignoring_comments))),
    ("Line comments end only at LF, not CR", lambda: patched((policy_gate, "_LINE_ENDS", "\n"))),
    (
        "Applications may be named by variables or indexes",
        lambda: patched(
            (policy_gate, "_NON_LITERAL_TARGET", re.compile(r"(?!)")),
            (policy_gate, "_NON_LITERAL_NAME_FILTER", re.compile(r"(?!)")),
        ),
    ),
    (
        "Handler values interpolated without escaping",
        lambda: patched((policy_gate, "applescript_literal", lambda value: f'"{value}"')),
    ),
    (
        "Timed-out or confirmed commands are re-run",
        lambda: patched((main, "_unsafe_to_rerun", lambda error: error.startswith("Blocked by policy:"))),
    ),
    ("Executed scripts not recorded", lambda: patched((tracing, "record_script", lambda script: None))),
    ("Latency percentile uses a rounded index", lambda: patched((audit, "_percentile", _rounded_percentile))),
    ("Email commands not recognised", lambda: patched((main, "_wants_email_compose", lambda command: False))),
    ("Repair loop disabled", lambda: patched((main, "MAX_REPAIR_ATTEMPTS", 0))),
    ("Token usage not recorded", lambda: patched((tracing, "record_usage", lambda *a, **k: None))),
    ("Audit schema migration skipped", lambda: patched((audit, "_migrate", lambda conn: None))),
    ("command_id and action only added to new audit databases", lambda: _v3_columns_only_in_new_databases()),
    ("Audit filters ignored", lambda: patched((audit, "_query", _query_ignoring_filters))),
    ("Last full audit page points past the end", lambda: patched((audit, "page", _page_without_lookahead))),
    ("API responses cacheable", lambda: patched((security, "_API_HEADERS", {}))),
    ("Event stream is public", lambda: patched((security, "_is_public", _event_stream_public))),
    ("Cancel does not revoke the pending id", lambda: patched((permissions, "cancel_pending", _cancel_without_revoking))),
    ("GET /pending lists expired entries", lambda: patched((permissions, "list_pending", _list_pending_unpruned))),
    ("Parking looks up the recipient in Contacts", lambda: patched((main, "_pending_details", _details_with_contact_lookup))),
    ("client_id accepted without validation", lambda: patched((main, "_client_id", lambda value: value))),
    (
        "Commands run concurrently",
        lambda: patched(
            (main, "_new_command_worker", lambda: ThreadPoolExecutor(max_workers=4, thread_name_prefix="imperium-command"))
        ),
    ),
    ("Commands run on the event loop", lambda: patched((main, "_execute_command", _execute_on_event_loop))),
    (
        "Worker drops the confirmed context",
        lambda: patched((main, "contextvars", types.SimpleNamespace(copy_context=contextvars.Context))),
    ),
    ("Replay ignores Last-Event-ID", lambda: patched((events.EventBus, "_replay_after", lambda self, last_event_id: None))),
    ("Replay ignores the boot", lambda: patched((events.EventBus, "_replay_after", _replay_after_any_boot))),
    ("Event stream subscribers not capped", lambda: patched((events, "MAX_SUBSCRIBERS", 10**6))),
    ("Overflowing subscribers never dropped", lambda: patched((events.EventBus, "_deliver", _deliver_ignoring_overflow))),
    ("Subscriber queue outgrows the replay buffer", lambda: patched((events, "QUEUE_SIZE", events.BUFFER_SIZE + 56))),
    ("Hello frame carries the pairing URL", lambda: patched((events.EventBus, "hello", _hello_with_pairing_url))),
    ("CSP allows inline scripts", lambda: patched((frontend_host, "content_security_policy", _csp_allowing_inline_scripts))),
    (
        "Framing allowed (frame-ancestors and X-Frame-Options dropped)",
        lambda: patched(
            (frontend_host, "content_security_policy", _csp_without_frame_ancestors),
            (frontend_host, "SECURITY_HEADERS", {k: v for k, v in frontend_host.SECURITY_HEADERS.items() if k != "X-Frame-Options"}),
        ),
    ),
    ("CSP hashes scripts a browser never runs", lambda: patched((frontend_host, "executes", lambda attributes: True))),
    ("Script type and language not stripped before comparison", lambda: patched((frontend_host, "executes", _executes_without_stripping))),
    ("A path the filesystem cannot express escapes the export host", lambda: patched((frontend_host, "_UNSERVABLE", ()))),
    ("Commands are not repaired to encodable text", lambda: patched((main, "_encodable", lambda text: text))),
    ("Confirmation details parse the whole command", lambda: patched((main, "DETAILS_PREVIEW_CHARS", 10**9))),
    ("A send hides a recipient the parser could not read", lambda: patched((main, "UNREADABLE_RECIPIENT", ""))),
    ("Audit failures other than sqlite3's break the command", lambda: patched((audit, "log_event", _log_event_for_sqlite_errors_only))),
    ("Pairing token compared as text, not bytes", lambda: patched((security, "_token_matches", _token_matches_as_text))),
    ("Comments do not hide scripts from the CSP tokenizer", lambda: patched((frontend_host, "_comment_end", lambda text, i: i))),
    ("Newlines not normalized before hashing", lambda: patched((frontend_host, "_input_stream", lambda document: document))),
    ("Script text ends at the first </script>", lambda: patched((frontend_host, "_script_end", _script_end_at_first_close))),
]


def run_mutations(tasks: list[dict], guard: Guard, base: Path) -> list[dict]:
    outcomes = []
    for name, make in MUTATIONS:
        with make():
            caught_by = [
                task["id"]
                for task in tasks
                if run_task(task, guard, base).status != "pass"
            ]
        outcomes.append({"mutation": name, "caught": bool(caught_by), "caught_by": caught_by})
    return outcomes


# --- Orchestration ----------------------------------------------------------


def run_task(task: dict, guard: Guard | None, base: Path, isolate: bool = True) -> Result:
    started = time.perf_counter()
    if guard is not None:
        guard.trips.clear()
    state = isolated_state(base) if isolate else contextlib.nullcontext()
    try:
        with state, contextlib.redirect_stdout(io.StringIO()):
            passed, detail = EXECUTORS[task["type"]](task)
        status = "pass" if passed else "fail"
    except Refused as e:
        status, detail = "refused", str(e)
    except OfflineViolation as e:
        status, detail = "fail", str(e)
    except Exception as e:
        status, detail = "error", f"{type(e).__name__}: {e}"
    if guard is not None and guard.trips:
        status = "fail"
        detail = f"tried to reach the Mac or a model: {sorted(set(guard.trips))}"
    return Result(task, status, detail, time.perf_counter() - started)


LABEL = {"pass": "PASS", "fail": "FAIL", "error": "ERR ", "refused": "REFU", "not_run": "SKIP"}


def report(result: Result) -> Result:
    task = result.task
    line = f"  {LABEL[result.status]}  {task['category']:<18} {task['id']}"
    if result.status != "pass":
        line += f"\n        {result.detail}"
    print(line)
    return result


def load_tasks(path: Path) -> list[dict]:
    tasks = yaml.safe_load(path.read_text())["tasks"]
    ids = [task["id"] for task in tasks]
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        raise SystemExit(f"duplicate task ids in {path.name}: {duplicates}")
    for task in tasks:
        if task.get("suite") not in ("offline", "live"):
            raise SystemExit(f"task {task['id']!r}: suite must be offline or live")
        if task.get("type") not in EXECUTORS:
            raise SystemExit(f"task {task['id']!r}: unknown type {task.get('type')!r}")
        if (task["type"] == "live") != (task["suite"] == "live"):
            raise SystemExit(f"task {task['id']!r}: live tasks must use type live, and only live tasks may")
    return tasks


def git_revision() -> tuple[str, bool]:
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True
        ).stdout.strip()
        dirty = bool(
            subprocess.run(
                ["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True
            ).stdout.strip()
        )
        return commit or "unknown", dirty
    except OSError:
        return "unknown", False


def _cell(text: str) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def _rate(passed: int, total: int) -> str:
    return f"{passed / total:.0%}" if total else "—"


def write_results(
    offline: list[Result],
    mutations: list[dict] | None,
    live: list[Result],
    live_tasks: list[dict],
    live_reason: str | None,
    live_stats: dict | None,
    commit: str,
    dirty: bool,
) -> None:
    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    offline_passed = sum(r.status == "pass" for r in offline)
    lines = [
        "# Eval Results",
        "",
        f"_Generated {now} on commit `{commit}`"
        f"{' with uncommitted changes' if dirty else ''} by `python3 evals/runner.py`"
        f"{' --live' if live else ''}. Do not edit by hand._",
        "",
        "## Summary",
        "",
        "| Suite | Measures | Result |",
        "|---|---|---|",
        f"| Offline | Safety and reliability layers (regression suite, must stay at 100%) "
        f"| **{offline_passed}/{len(offline)} passed** |",
    ]
    if mutations is not None:
        caught = sum(m["caught"] for m in mutations)
        lines.append(
            f"| Mutation check | Deliberately broken safety properties the offline suite detects "
            f"| **{caught}/{len(mutations)} caught** |"
        )
    if live:
        live_passed = sum(r.status == "pass" for r in live)
        lines.append(
            f"| Live | End-to-end task success on a real Mac, verified against macOS state "
            f"| **{live_passed}/{len(live)} passed ({_rate(live_passed, len(live))})** |"
        )
    else:
        lines.append(f"| Live | End-to-end task success on a real Mac | Not run: {_cell(live_reason)} |")

    categories: dict[str, list[int]] = {}
    for result in offline:
        counts = categories.setdefault(result.task["category"], [0, 0])
        counts[0] += result.status == "pass"
        counts[1] += 1
    lines += ["", "## Offline suite by category", "", "| Category | Passed |", "|---|---|"]
    for category, (passed, total) in sorted(categories.items()):
        lines.append(f"| {category} | {passed}/{total} |")

    if mutations is not None:
        lines += [
            "",
            "## Mutation check",
            "",
            "Each row deliberately breaks one safety property in memory, then reruns the "
            "offline suite. A mutation counts as caught when at least one task fails.",
            "",
            "| Mutation | Caught | Detected by |",
            "|---|---|---|",
        ]
        for m in mutations:
            shown = ", ".join(f"`{i}`" for i in m["caught_by"][:3])
            extra = f" +{len(m['caught_by']) - 3} more" if len(m["caught_by"]) > 3 else ""
            lines.append(f"| {m['mutation']} | {'yes' if m['caught'] else '**NO**'} | {shown}{extra} |")

    lines += ["", "## Live suite", ""]
    if live:
        repaired_passes = sum(
            1 for r in live if r.status == "pass" and r.trace.get("repair_succeeded")
        )
        live_passed = sum(r.status == "pass" for r in live)
        lines += ["| Metric | Value |", "|---|---|"]
        lines.append(f"| Verified task success | {live_passed}/{len(live)} ({_rate(live_passed, len(live))}) |")
        lines.append(
            f"| Success without the repair loop | {live_passed - repaired_passes}/{len(live)} "
            f"({_rate(live_passed - repaired_passes, len(live))}) |"
        )
        if live_stats:
            lines.append(f"| p50 / p95 latency | {live_stats.get('p50_latency_ms')} ms / {live_stats.get('p95_latency_ms')} ms |")
            commands = live_stats.get("commands") or 0
            if commands:
                lines.append(
                    f"| Mean tokens per command | {live_stats.get('input_tokens', 0) // commands} in / "
                    f"{live_stats.get('output_tokens', 0) // commands} out |"
                )
            lines.append(f"| Repair attempts | {live_stats.get('repair_attempts')} |")
    else:
        lines += [
            f"Not run: {live_reason}. {len(live_tasks)} live tasks are defined in `tasks.yaml` "
            "and run with `python3 evals/runner.py --live`. No live numbers are reported until "
            "they have actually been measured.",
        ]

    lines += ["", "## All tasks", "", "| Task | Suite | Category | Result | Detail |", "|---|---|---|---|---|"]
    for result in offline + live:
        task = result.task
        lines.append(
            f"| `{task['id']}` | {task['suite']} | {task['category']} | {result.status} | {_cell(result.detail)} |"
        )
    RESULTS_FILE.write_text("\n".join(lines) + "\n")


def main_cli() -> int:
    parser = argparse.ArgumentParser(description="Run the Imperium eval suites.")
    parser.add_argument("--live", action="store_true", help="also run the live suite on this Mac")
    parser.add_argument("--only", nargs="+", metavar="ID", help="run only these task ids")
    parser.add_argument("--no-mutations", action="store_true", help="skip the mutation check")
    parser.add_argument("--no-write", action="store_true", help="do not rewrite evals/RESULTS.md")
    args = parser.parse_args()

    tasks = load_tasks(TASKS_FILE)
    if args.only:
        unknown = sorted(set(args.only) - {task["id"] for task in tasks})
        if unknown:
            raise SystemExit(f"unknown task ids: {unknown}")
        tasks = [task for task in tasks if task["id"] in args.only]
    commit, dirty = git_revision()
    offline_tasks = [task for task in tasks if task["suite"] == "offline"]
    live_tasks = [task for task in tasks if task["suite"] == "live"]

    with tempfile.TemporaryDirectory(prefix="imperium-evals-") as tmp:
        base = Path(tmp)
        guard = Guard()

        print(f"\nOffline suite: {len(offline_tasks)} tasks (process spawns, keystrokes, and model calls intercepted)")
        with offline_guards(guard):
            offline_results = [report(run_task(task, guard, base)) for task in offline_tasks]
            mutations = None
            if not args.no_mutations and offline_tasks:
                print(f"\nMutation check: {len(MUTATIONS)} mutations")
                mutations = run_mutations(offline_tasks, guard, base)
                for m in mutations:
                    print(f"  {'CAUGHT ' if m['caught'] else 'MISSED '} {m['mutation']}")

        live_results: list[Result] = []
        live_stats = None
        if not live_tasks:
            live_reason = "no live tasks selected"
        elif not args.live:
            live_reason = "not requested (run with --live on a Mac with ANTHROPIC_API_KEY set)"
        else:
            live_reason = live_preflight()
        if args.live and live_tasks and live_reason is None:
            print(f"\nLive suite: {len(live_tasks)} tasks on this Mac")
            with isolated_state(base):
                for task in live_tasks:
                    result = run_task(task, None, base, isolate=False)
                    rows = audit.recent(1)
                    if rows and rows[0].get("command") == task["command"]:
                        result.trace = rows[0]
                    live_results.append(report(result))
                live_stats = audit.stats()
        elif live_tasks:
            print(f"\nLive suite: not run ({live_reason})")

    if not args.no_write:
        write_results(
            offline_results, mutations, live_results, live_tasks, live_reason, live_stats, commit, dirty
        )
        print(f"\nWrote {RESULTS_FILE.relative_to(ROOT)}")

    offline_failed = sum(r.status != "pass" for r in offline_results)
    missed = sum(not m["caught"] for m in mutations) if mutations else 0
    print(
        f"\nOffline {len(offline_results) - offline_failed}/{len(offline_results)} passed"
        + (f", mutations {len(mutations) - missed}/{len(mutations)} caught" if mutations else "")
    )
    return 1 if offline_failed or missed else 0


if __name__ == "__main__":
    sys.exit(main_cli())
