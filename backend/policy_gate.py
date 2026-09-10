"""Security gate for generated AppleScript.

`applescript_validate` checks that a script will run correctly; this module
checks that it is *allowed* to run. Every script reaching `_osascript_pipe`
passes through `check_script` first — Claude output is never executed raw.

Two layers:
1. Banned constructs — shell escape hatches, credential access, destructive
   file operations, power/session control.
2. App allowlist — every `tell application "X"` target must be an app the
   config permits the agent to control (~/.imperium/permissions.json).
"""

from __future__ import annotations

import re

import permissions

# (pattern, human-readable reason) — matched case-insensitively
_BANNED: list[tuple[str, str]] = [
    (r"\bdo\s+shell\s+script\b", "shell execution from AppleScript is not allowed"),
    (r"\bsudo\b", "privilege escalation is not allowed"),
    (r"\brm\s+(-\w+\s+)*/", "file deletion commands are not allowed"),
    (r"\bpassword\b", "scripts may not reference passwords"),
    (r"\bkeychain\b|\bsecurity\s+find-", "credential store access is not allowed"),
    (r"\bdelete\s+(file|folder|item|every\s+file|every\s+item)\b", "deleting files requires manual action"),
    (r"\bempty\s+(the\s+)?trash\b", "emptying trash requires manual action"),
    (r"\bshut\s*down\b|\brestart\b|\blog\s*out\b|\bsleep\b", "power/session control is not allowed"),
    (r"\berase\b|\bformat\s+disk\b|\bdiskutil\b", "disk operations are not allowed"),
]

_TELL_APP = re.compile(r'\btell\s+app(?:lication)?\s+(?:process\s+)?"([^"]+)"', re.IGNORECASE)


def _without_string_literals(script: str) -> str:
    """Strip quoted literals so words in user-facing text don't trip bans."""
    return re.sub(r'"((?:[^"\\]|\\.)*)"', '""', script)


def check_script(script: str) -> tuple[bool, str]:
    """Return (allowed, reason). Reason is empty when allowed."""
    stripped = _without_string_literals(script)

    for pattern, reason in _BANNED:
        if re.search(pattern, stripped, re.IGNORECASE):
            return False, reason

    allowlist = {name.lower() for name in permissions.app_allowlist()}
    for target in _TELL_APP.findall(script):
        if target.lower() not in allowlist:
            return False, (
                f'app "{target}" is not in the allowlist '
                "(edit ~/.imperium/permissions.json to allow it)"
            )

    return True, ""
