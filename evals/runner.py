#!/usr/bin/env python3
"""Imperium eval runner.

Two suites, one task file (evals/tasks.yaml):

  offline  Deterministic checks of the safety and reliability layers:
           command classification, the permission gate and confirm flow,
           the script policy gate, the AppleScript validator, auth, the
           retry-with-repair loop, tracing, and the audit schema migration.
           Needs no API key and never drives the Mac: process spawns,
           keystrokes, and model calls are intercepted and fail the task,
           and importing the backend is guarded the same way (only `uname`,
           run by the standard library, is let through). Every task gets its
           own temporary token, config, and audit database, so ~/.imperium
           is never read or written. Built-in handlers are checked for
           AppleScript injection by capturing the scripts they build.

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
import contextlib
import datetime as dt
import io
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import types
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
    with patched(
        (security, "IMPERIUM_DIR", state),
        (security, "TOKEN_FILE", state / "token"),
        (security, "_token_cache", None),
        (permissions, "CONFIG_FILE", state / "permissions.json"),
        (permissions, "_config_cache", None),
        (permissions, "_pending", {}),
        (audit, "DB_FILE", state / "audit.db"),
    ):
        yield state


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
    decisions = [entry["decision"] for entry in audit.recent(200)]
    for decision in task.get("expect_audit") or []:
        c.expect(decision in decisions, f"audit lacks {decision!r} (has {decisions})")
    for decision in task.get("forbid_audit") or []:
        c.expect(decision not in decisions, f"audit contains forbidden {decision!r}")
    return c.outcome(f"HTTP {response.status_code}")


def run_confirm_flow(task: dict) -> tuple[bool, str]:
    c = Checks()
    client = TestClient(main.app, raise_server_exceptions=False)
    headers = auth_headers("valid")
    command = task.get("command", "send a text to John saying hi")
    executed: list[str] = []

    async def recorder(data, cmd):
        executed.append(cmd)
        return {"transcript": cmd, "action": "recorded", "osascript_ok": True}

    def park(cmd: str) -> str:
        body = _json_or_none(client.post("/text-command", headers=headers, json={"command": cmd})) or {}
        c.expect(body.get("requires_confirmation") is True, f"{cmd!r} was not parked: {body}")
        return body.get("pending_id", "missing")

    def confirm(pending_id: str, **kwargs):
        return client.post(f"/confirm/{pending_id}", **kwargs)

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


def run_migration(task: dict) -> tuple[bool, str]:
    c = Checks()
    audit.DB_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    conn = sqlite3.connect(audit.DB_FILE)
    conn.execute(LEGACY_AUDIT_SCHEMA)
    conn.execute("INSERT INTO audit (ts, command, decision) VALUES (1.0, 'legacy row', 'executed')")
    conn.commit()
    conn.close()

    audit.log_event("executed", command="post-migration row", trace={"input_tokens": 7})

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
