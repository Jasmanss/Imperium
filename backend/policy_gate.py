"""Security gate for model-generated AppleScript.

`applescript_validate` checks that a script will run correctly; this module
checks that it is *allowed* to run. Every script the model writes — and every
script the repair loop produces — passes `check_script` before it executes.
Built-in handlers (Spotify, iMessage, email, Contacts, Chrome, quit-all) run
fixed templates instead and must quote every interpolated value with
`applescript_literal`.

The checks run against what AppleScript will execute. `_lex` mirrors
AppleScript's lexer — double-quoted strings with backslash escapes, `--` and
`#` line comments, nested `(* *)` block comments whose contents are still
lexed for strings, and `¬` line continuations — so quotes inside comments
cannot hide code from the patterns below.

Four layers:
1. Banned constructs — shell escape hatches (`do shell script`, running strings
   or files as AppleScript, raw Apple event codes), credential and raw file
   access, browser JavaScript, destructive file operations, power/session
   control.
2. App allowlist — applications and processes must be named with string
   literals, and every name (including .app bundle paths) must be allowlisted;
   bundle ids are refused because they cannot be checked by name.
3. Partial process-name filters that could match a shell-capable app.
4. Outward-facing actions — sending mail or messages only runs when the user
   confirmed the command on their phone.

This is a static filter over untrusted text, not a sandbox. SECURITY.md lists
what it cannot catch.
"""

from __future__ import annotations

import re

import permissions

# (pattern, human-readable reason) — matched case-insensitively against the
# code with comments removed and string literals blanked
_BANNED: list[tuple[str, str]] = [
    (r"\bdo\s+shell\s+script\b", "shell execution from AppleScript is not allowed"),
    (r"\b(?:run|load|store)\s+script\b", "running strings or files as AppleScript is not allowed"),
    (r"«\s*event\b", "raw Apple event codes are not allowed"),
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
    r'\bapp(?:lication)?\s+(?:id\s+|process\s+|file\s+(?:id\s+)?)?"([^"]+)"'
    r'|\bprocess\s+"([^"]+)"'
    r'|\b(?:app(?:lication)?|process)(?:es|s)?\s+whose\s+name\s+(?:is|=)\s+"([^"]+)"',
    re.IGNORECASE,
)

# An application or process named any other way — a variable, an index, an
# expression — cannot be checked against the allowlist.
_NON_LITERAL_TARGET = re.compile(
    r'(?<!frontmost\s)(?<!current\s)\bapp(?:lication)?\b'
    r'(?!\s*(?:"|id\s+"|file\s+(?:id\s+)?"|process(?:es)?\b))'
    r'|(?<!every\s)\bprocess\b(?!\s*(?:"|whose\b))',
    re.IGNORECASE,
)

_NON_LITERAL_NAME_FILTER = re.compile(
    r'\b(?:app(?:lication)?|process)(?:es|s)?\s+whose\s+name\s+'
    r'(?:is\s+not|is(?!\s+not\b)|=|≠|contains|starts\s+with|begins\s+with|ends\s+with)\s+(?![\s"])',
    re.IGNORECASE,
)

_APP_NAME_FRAGMENT = re.compile(
    r'\b(?:app(?:lication)?|process)(?:es|s)?\s+whose\s+name\s+'
    r'(?:contains|starts\s+with|begins\s+with|ends\s+with)\s+"([^"]+)"',
    re.IGNORECASE,
)

_BUNDLE_PATH = re.compile(r'"([^"]*\.app)[/:]?"', re.IGNORECASE)

_BUNDLE_ID = re.compile(r"^(?:com|org|net|io|dev|app|co)\.[\w-]+(?:\.[\w-]+)+$", re.IGNORECASE)

_STRING_LITERAL = re.compile(r'"((?:[^"\\]|\\.)*)"')

# AppleScript ends a line at a carriage return as well as a line feed.
_LINE_ENDS = "\r\n"

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


def applescript_literal(value: str) -> str:
    """Quote a value as an AppleScript string literal."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _lex(script: str) -> tuple[str, str]:
    """Return (code, bare): what AppleScript executes, with comments removed.

    `code` keeps string literals; `bare` blanks them to "" so words inside
    user-facing text don't trip the patterns.
    """
    code: list[str] = []
    bare: list[str] = []
    depth = 0
    i, n = 0, len(script)
    while i < n:
        ch = script[i]
        if ch == '"':
            end = i + 1
            while end < n and script[end] != '"':
                end += 2 if script[end] == "\\" else 1
            if not depth:
                code.append(script[i : end + 1])
                bare.append('""')
            i = end + 1
        elif script.startswith("(*", i):
            depth += 1
            i += 2
        elif depth and script.startswith("*)", i):
            depth -= 1
            i += 2
            if not depth:
                code.append(" ")
                bare.append(" ")
        elif depth:
            i += 1
        elif script.startswith("--", i) or ch == "#":
            while i < n and script[i] not in _LINE_ENDS:
                i += 1
        elif ch == "¬":
            i += 1
            while i < n and script[i] in " \t\r\n":
                i += 1
            code.append(" ")
            bare.append(" ")
        else:
            code.append(ch)
            bare.append(ch)
            i += 1
    return "".join(code), "".join(bare)


def _literals(code: str) -> list[str]:
    return [re.sub(r"\\(.)", r"\1", literal) for literal in _STRING_LITERAL.findall(code)]


def _app_name(name: str) -> str:
    return re.sub(r"\.app[/:]?$", "", name.strip(), flags=re.IGNORECASE).lower()


def _app_references(code: str) -> list[str]:
    """Every application or process the script names with a literal."""
    return [next(group for group in match if group) for match in _APP_REFERENCE.findall(code)]


def _bundle_names(code: str) -> list[str]:
    """App bundle names taken from quoted .app paths (POSIX or HFS)."""
    return [re.split(r"[/:]", path.rstrip("/:"))[-1] for path in _BUNDLE_PATH.findall(code)]


def check_script(script: str) -> tuple[bool, str]:
    """Return (allowed, reason). Reason is empty when allowed."""
    code, bare = _lex(script)

    for pattern, reason in _BANNED:
        if re.search(pattern, bare, re.IGNORECASE):
            return False, reason

    if _NON_LITERAL_TARGET.search(bare) or _NON_LITERAL_NAME_FILTER.search(bare):
        return False, "applications and processes must be named with a string literal"

    allowlist = {name.lower() for name in permissions.app_allowlist()}
    referenced = _app_references(code)
    for name in referenced + _bundle_names(code):
        if _app_name(name) not in allowlist:
            return False, (
                f'app "{name}" is not in the allowlist '
                "(edit ~/.imperium/permissions.json to allow it)"
            )

    for literal in _literals(code):
        if _BUNDLE_ID.match(literal.strip()):
            return False, f'bundle id "{literal}" cannot be checked against the allowlist'

    for fragment in _APP_NAME_FRAGMENT.findall(code):
        lowered = fragment.lower()
        if any(lowered in app or app in lowered for app in _SHELL_CAPABLE_APPS):
            return False, f'process filter "{fragment}" could match a shell-capable app'

    if (
        {_app_name(name) for name in referenced} & _OUTWARD_APPS
        and _OUTWARD_VERB.search(bare)
        and not permissions.is_confirmed()
    ):
        return False, (
            "sending mail or messages requires confirmation — phrase it as "
            '"send an email to…" or "send a text to…" so you can confirm it on your phone'
        )

    return True, ""
