"""Security gate for generated AppleScript.

`applescript_validate` checks that a script will run correctly; this module
checks that it is *allowed* to run. Every script reaching `_osascript_pipe`
passes through `check_script` first — Claude output is never executed raw.

Three layers:
1. Banned constructs — shell escape hatches (including running strings or
   files as AppleScript), credential and raw file access, destructive file
   operations, power/session control.
2. App allowlist — every form that names an application (tell, activate,
   launch, bundle id, System Events process, process-name filters, .app
   bundle paths) must resolve to an app the config permits.
3. Outward-facing actions — sending mail or messages only runs when the user
   confirmed the command on their phone.

This is a static filter over untrusted text, not a sandbox. SECURITY.md lists
what it cannot catch.
"""

from __future__ import annotations

import re

import permissions

# (pattern, human-readable reason) — matched case-insensitively against the
# script with string literals removed
_BANNED: list[tuple[str, str]] = [
    (r"\bdo\s+shell\s+script\b", "shell execution from AppleScript is not allowed"),
    (r"\b(?:run|load|store)\s+script\b", "running strings or files as AppleScript is not allowed"),
    (r"\bsudo\b", "privilege escalation is not allowed"),
    (r"\brm\s+(-\w+\s+)*/", "file deletion commands are not allowed"),
    (r"\bpassword\b", "scripts may not reference passwords"),
    (r"\bkeychain\b|\bsecurity\s+find-", "credential store access is not allowed"),
    (r"\bopen\s+for\s+access\b|\bread\s+\(?\s*(?:POSIX\s+)?file\b", "raw file access is not allowed"),
    (r"\bdo\s+javascript\b|\bexecute\b.*\bjavascript\b", "running JavaScript in the browser is not allowed"),
    (r"\bdelete\s+(file|folder|item|every\s+file|every\s+item)\b", "deleting files requires manual action"),
    (r"\bmove\b.*\bto\s+(?:the\s+)?trash\b", "deleting files requires manual action"),
    (r"\bempty\s+(the\s+)?trash\b", "emptying trash requires manual action"),
    (r"\bshut\s*down\b|\brestart\b|\blog\s*out\b|\bsleep\b", "power/session control is not allowed"),
    (r"\berase\b|\bformat\s+disk\b|\bdiskutil\b", "disk operations are not allowed"),
]

_APP_REFERENCE = re.compile(
    r'\bapp(?:lication)?\s+(?:id\s+|process\s+)?"([^"]+)"'
    r'|\bprocess\s+"([^"]+)"'
    r'|\b(?:app(?:lication)?|process)(?:es|s)?\s+whose\s+name\s+(?:is|=)\s+"([^"]+)"',
    re.IGNORECASE,
)

_APP_NAME_FRAGMENT = re.compile(
    r'\b(?:app(?:lication)?|process)(?:es|s)?\s+whose\s+name\s+'
    r'(?:contains|starts\s+with|begins\s+with|ends\s+with)\s+"([^"]+)"',
    re.IGNORECASE,
)

_BUNDLE_PATH = re.compile(r'"([^"]*\.app)/?"', re.IGNORECASE)

# Partial-name process filters can't be checked against the allowlist exactly,
# so they are rejected when they could match an app that runs arbitrary
# commands or changes security settings.
_SHELL_CAPABLE_APPS = (
    "terminal", "iterm", "iterm2", "warp", "kitty", "alacritty", "wezterm", "ghostty",
    "script editor", "automator", "shortcuts", "keychain access",
    "system settings", "system preferences",
)

_OUTWARD_APPS = {"mail", "messages"}
_OUTWARD_VERB = re.compile(r"\b(?:send|forward|redirect)\b", re.IGNORECASE)


def _without_string_literals(script: str) -> str:
    """Strip quoted literals so words in user-facing text don't trip bans."""
    return re.sub(r'"((?:[^"\\]|\\.)*)"', '""', script)


def _app_references(script: str) -> list[str]:
    """Every application or process the script names directly."""
    return [next(group for group in match if group) for match in _APP_REFERENCE.findall(script)]


def _bundle_names(script: str) -> list[str]:
    """App names taken from quoted .app bundle paths (POSIX or HFS)."""
    names = []
    for path in _BUNDLE_PATH.findall(script):
        leaf = re.split(r"[/:]", path.rstrip("/:"))[-1]
        names.append(leaf[: -len(".app")])
    return names


def check_script(script: str) -> tuple[bool, str]:
    """Return (allowed, reason). Reason is empty when allowed."""
    stripped = _without_string_literals(script)

    for pattern, reason in _BANNED:
        if re.search(pattern, stripped, re.IGNORECASE):
            return False, reason

    allowlist = {name.lower() for name in permissions.app_allowlist()}
    referenced = _app_references(script)
    for name in referenced + _bundle_names(script):
        if name.lower() not in allowlist:
            return False, (
                f'app "{name}" is not in the allowlist '
                "(edit ~/.imperium/permissions.json to allow it)"
            )

    for fragment in _APP_NAME_FRAGMENT.findall(script):
        lowered = fragment.lower()
        if any(lowered in app or app in lowered for app in _SHELL_CAPABLE_APPS):
            return False, f'process filter "{fragment}" could match a shell-capable app'

    if (
        {name.lower() for name in referenced} & _OUTWARD_APPS
        and _OUTWARD_VERB.search(stripped)
        and not permissions.is_confirmed()
    ):
        return False, (
            "sending mail or messages requires confirmation — phrase it as "
            '"send an email to…" or "send a text to…" so you can confirm it on your phone'
        )

    return True, ""
