#!/usr/bin/env python3
"""Check the built frontend export exactly as the backend serves it at /app.

`npm run build` writes a static export to frontend/out. This script points the
backend's /app host at that directory and drives it in-process with FastAPI's
TestClient — no server is started, no command is ever executed, and ~/.imperium
is never read or written (the token, permissions, audit database, event bus, and
command worker are all redirected into a temporary directory).

It checks, for the real build:

  * every exported HTML page is served, with the right status and content type,
    and the bytes on disk;
  * a few _next/static assets are served, immutable and with the right type;
  * every /app URL a page loads itself resolves, so a basePath change or a
    half-finished build cannot ship an export that renders blank;
  * a path that does not exist answers 404 with the export's own 404 page;
  * every response carries the security headers, and each page's CSP lists the
    sha256 hash of exactly the inline scripts a browser would run in it, with no
    'unsafe-inline' and no 'unsafe-eval';
  * every API route the frontend calls answers 401 without a pairing token.

The script hashes are recomputed here by this file's own HTML scanner, never by
importing the backend's: if the two ever disagree, a page's scripts would be
blocked in the browser, and that is exactly what this catches.

Usage: python evals/check_frontend_export.py   (exit 0 = everything checked out)
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import html
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
EXPORT = ROOT / "frontend" / "out"

sys.path.insert(0, str(BACKEND))


class OfflineViolation(Exception):
    """This script tried to reach the Mac, a process, or a model."""


def _only_uname(real):
    def spawn(args, *rest, **kwargs):
        program = args[0] if isinstance(args, (list, tuple)) else str(args).split()[0]
        if Path(str(program)).name == "uname":
            return real(args, *rest, **kwargs)
        raise OfflineViolation("importing the backend tried to run %r" % (args,))

    return spawn


# Importing the backend must not reach the Mac. The standard library's `platform`
# module runs `uname`, which is harmless; nothing else is allowed.
_real_run, _real_popen = subprocess.run, subprocess.Popen
subprocess.run = _only_uname(_real_run)
subprocess.Popen = _only_uname(_real_popen)
try:
    import audit
    import events
    import main
    import permissions
    import security

    from fastapi.testclient import TestClient
finally:
    subprocess.run, subprocess.Popen = _real_run, _real_popen


# --- this file's own HTML scanner -------------------------------------------
#
# Deliberately written from the HTML spec rather than shared with the backend.

_SPACE = "\t\n\f\r "
# Elements whose content is text, not markup: a "<script" inside one is not a tag.
_TEXT_ONLY = ("title", "textarea", "style", "noscript", "iframe", "noembed", "noframes", "xmp")
# Script types a browser executes; anything else (and any src) it does not run inline.
_RUNS = (
    "", "module", "importmap", "speculationrules",
    "application/ecmascript", "application/javascript", "application/x-ecmascript",
    "application/x-javascript", "text/ecmascript", "text/javascript", "text/javascript1.0",
    "text/javascript1.1", "text/javascript1.2", "text/javascript1.3", "text/javascript1.4",
    "text/javascript1.5", "text/jscript", "text/livescript", "text/x-ecmascript",
    "text/x-javascript",
)


def _tag_at(text, i):
    """Parse the tag starting at `<` in `text`; returns (name, attributes, end) or None."""
    n = len(text)
    if i + 1 >= n or not (text[i + 1].isascii() and text[i + 1].isalpha()):
        return None
    j = i + 1
    while j < n and text[j] not in _SPACE + "/>":
        j += 1
    name = text[i + 1 : j].lower()
    attributes = {}
    while j < n:
        if text[j] in _SPACE or text[j] == "/":
            j += 1
            continue
        if text[j] == ">":
            return name, attributes, j + 1
        start = j + 1  # the first character is part of the name even if it is "="
        while start < n and text[start] not in _SPACE + "/>=":
            start += 1
        key = text[j:start].lower()
        j = start
        while j < n and text[j] in _SPACE:
            j += 1
        value = ""
        if j < n and text[j] == "=":
            j += 1
            while j < n and text[j] in _SPACE:
                j += 1
            if j < n and text[j] in "\"'":
                quote = text[j]
                close = text.find(quote, j + 1)
                if close == -1:
                    return None  # unterminated attribute: the browser drops the tag
                value, j = text[j + 1 : close], close + 1
            else:
                start = j
                while start < n and text[start] not in _SPACE + ">":
                    start += 1
                value, j = text[j:start], start
        if key not in attributes:
            attributes[key] = value
    return None


def _closes(text, i, name):
    """Whether an end tag for `name` starts at i."""
    stop = i + 2 + len(name)
    return (
        text.startswith("</", i)
        and text[i + 2 : stop].lower() == name
        and stop < len(text)
        and text[stop] in _SPACE + "/>"
    )


def _past_tag(text, i):
    """The index just past the tag starting at i (end tags included)."""
    stop = text.find(">", i)
    return len(text) if stop == -1 else stop + 1


def _skip_comment(text, i):
    """The index just past a comment whose `<!--` ended at i."""
    if text.startswith(">", i):
        return i + 1
    if text.startswith("->", i):
        return i + 2
    stops = [p for p in (text.find("-->", i), text.find("--!>", i)) if p != -1]
    if not stops:
        return len(text)
    stop = min(stops)
    return stop + (3 if text.startswith("-->", stop) else 4)


def _script_text_end(text, i):
    """Where a script element's text ends, per the script data states.

    A `<!--` inside script text starts an escaped run; a `<script` inside that run
    makes `</script>` ordinary text until the matching `</script>`; `-->` ends the
    escaped run.
    """
    n = len(text)
    escaped = False  # inside <!-- ... -->
    nested = 0  # <script ...> seen inside an escaped run
    j = i
    while j < n:
        if text[j] != "<":
            if escaped and text.startswith("-->", j):
                escaped, j = False, j + 3
                continue
            j += 1
            continue
        if _closes(text, j, "script"):
            if nested:
                nested -= 1
                j = _past_tag(text, j)
                continue
            return j, _past_tag(text, j)
        if text.startswith("<!--", j):
            escaped, j = True, j + 4
            continue
        if escaped and _tag_at(text, j) is not None and text[j + 1 : j + 7].lower() == "script":
            nested += 1
            j = _past_tag(text, j)
            continue
        j += 1
    return n, n


def inline_script_sources(document):
    """The exact text of every inline script a browser would run, in document order."""
    # A browser normalizes newlines and NULs in its input stream before tokenizing,
    # and hashes what it tokenized.
    text = document.replace("\r\n", "\n").replace("\r", "\n").replace("\0", "�")
    sources = []
    i, n = 0, len(text)
    while i < n:
        lt = text.find("<", i)
        if lt == -1:
            break
        if text.startswith("<!--", lt):
            i = _skip_comment(text, lt + 4)
            continue
        if text.startswith("</", lt) or text[lt + 1 : lt + 2] in ("!", "?"):
            i = _past_tag(text, lt)
            continue
        parsed = _tag_at(text, lt)
        if parsed is None:
            i = lt + 1
            continue
        name, attributes, end = parsed
        if name == "script":
            stop, i = _script_text_end(text, end)
            if _executes(attributes):
                sources.append(text[end:stop])
            continue
        if name == "plaintext":
            break
        if name in _TEXT_ONLY:
            j = end
            while j < n and not _closes(text, j, name):
                j = text.find("<", j + 1)
                if j == -1:
                    j = n
                    break
            i = n if j >= n else _past_tag(text, j)
            continue
        i = end
    return sources


def _executes(attributes):
    """Whether a browser runs this script element's own text."""
    if "src" in attributes:
        return False
    if "type" in attributes:
        kind = attributes["type"].strip(_SPACE).lower()
    elif attributes.get("language"):
        kind = "text/" + attributes["language"].strip(_SPACE).lower()
    else:
        kind = ""
    if ";" in kind:
        kind = kind.split(";", 1)[0].strip(_SPACE)
    return kind in _RUNS


def expected_hashes(document):
    """CSP sha256 sources for a page's running inline scripts, in order, without repeats."""
    hashes = []
    for source in inline_script_sources(document):
        if not source:
            continue
        digest = hashlib.sha256(source.encode("utf-8")).digest()
        token = "sha256-" + base64.b64encode(digest).decode("ascii")
        if token not in hashes:
            hashes.append(token)
    return hashes


# --- isolation ---------------------------------------------------------------


@contextlib.contextmanager
def _patched(*patches):
    saved = [(obj, name, getattr(obj, name)) for obj, name, _ in patches]
    try:
        for obj, name, value in patches:
            setattr(obj, name, value)
        yield
    finally:
        for obj, name, value in reversed(saved):
            setattr(obj, name, value)


def _blocked(name):
    def blocked(*args, **kwargs):
        raise OfflineViolation("the export check attempted %s" % name)

    return blocked


@contextlib.contextmanager
def isolated_backend(export_dir):
    """The backend with its state in a temp directory and /app pointed at `export_dir`."""
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "imperium"
        worker = main._new_command_worker()
        with _patched(
            (security, "IMPERIUM_DIR", state),
            (security, "TOKEN_FILE", state / "token"),
            (security, "_token_cache", None),
            (permissions, "CONFIG_FILE", state / "permissions.json"),
            (permissions, "_config_cache", None),
            (permissions, "_pending", {}),
            (audit, "DB_FILE", state / "audit.db"),
            (events, "bus", events.EventBus()),
            (main, "_command_worker", worker),
            (main.frontend, "directory", Path(export_dir)),
            (main.frontend, "_files", None),
            (main.frontend, "_hash_cache", {}),
            (subprocess, "run", _blocked("subprocess.run")),
            (subprocess, "Popen", _blocked("subprocess.Popen")),
            (os, "system", _blocked("os.system")),
        ):
            try:
                yield state
            finally:
                worker.shutdown(wait=True)


# --- checks ------------------------------------------------------------------


class Report:
    def __init__(self):
        self.failures = []
        self.checks = 0

    def expect(self, condition, message):
        self.checks += 1
        if not condition:
            self.failures.append(message)
        return bool(condition)


SECURITY_HEADERS = {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}

# CSP directives every /app response must carry, beyond script-src.
REQUIRED_CSP = {
    "default-src": ["'self'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "frame-ancestors": ["'none'"],
    "connect-src": ["'self'"],
    "form-action": ["'self'"],
}

UNSAFE = ("'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "'strict-dynamic'", "*")

# Every API route the frontend calls, none of which may answer without a token.
API_ROUTES = (
    ("POST", "/text-command"),
    ("POST", "/confirm/0123456789ab"),
    ("DELETE", "/pending/0123456789ab"),
    ("GET", "/pending"),
    ("GET", "/audit?limit=50"),
    ("GET", "/stats"),
    ("GET", "/events"),
)


def directives(header):
    parsed = {}
    for part in header.split(";"):
        fields = part.split()
        if fields:
            parsed[fields[0].lower()] = fields[1:]
    return parsed


def page_urls(export_dir):
    """Every exported HTML file as (url path, file), discovered by walking the export."""
    pages = []
    for path in sorted(export_dir.rglob("*.html")):
        relative = path.relative_to(export_dir)
        if relative.name == "index.html":
            parent = relative.parent.as_posix()
            url = "/app/" if parent == "." else "/app/%s/" % parent
        else:
            url = "/app/%s" % relative.as_posix()
        pages.append((url, path))
    return pages


def static_assets(export_dir, limit=6):
    """A sample of hashed build assets, newest-looking first, as (url path, file)."""
    static = export_dir / "_next" / "static"
    if not static.is_dir():
        return []
    files = [p for p in sorted(static.rglob("*")) if p.is_file() and p.suffix in (".js", ".css")]
    chosen = files[:limit] if len(files) <= limit else files[:: max(1, len(files) // limit)][:limit]
    return [("/app/%s" % p.relative_to(export_dir).as_posix(), p) for p in chosen]


def check_headers(report, label, response, cache_control):
    for name, value in SECURITY_HEADERS.items():
        actual = response.headers.get(name)
        report.expect(actual == value, "%s: %s is %r, expected %r" % (label, name, actual, value))
    report.expect(
        response.headers.get("Cache-Control") == cache_control,
        "%s: Cache-Control is %r, expected %r"
        % (label, response.headers.get("Cache-Control"), cache_control),
    )
    csp = directives(response.headers.get("Content-Security-Policy", ""))
    for name, value in REQUIRED_CSP.items():
        report.expect(
            csp.get(name) == value,
            "%s: CSP %s is %r, expected %r" % (label, name, csp.get(name), value),
        )
    return csp


_REFERENCE = re.compile(r"""\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))""", re.IGNORECASE)


def referenced_urls(document):
    """The distinct /app URLs a page loads itself, in the order they appear."""
    urls = []
    for match in _REFERENCE.finditer(document):
        value = next(group for group in match.groups() if group is not None)
        value = html.unescape(value).split("#", 1)[0]
        if value.startswith("/app/") and value not in urls:
            urls.append(value)
    return urls


def check_references(report, client, url, document, seen):
    """Every asset the page names is actually served under /app.

    The pages are checked as bytes and headers everywhere else, which says
    nothing about whether the browser can load what they point at: drop
    `basePath: "/app"` from next.config.ts, or ship a truncated out/, and every
    page still passes while rendering blank. Each distinct URL is fetched once.
    """
    references = referenced_urls(document)
    report.expect(
        bool(references),
        "GET %s: the page references no /app asset — a page that loads nothing renders nothing" % url,
    )
    for reference in references:
        if reference in seen:
            continue
        seen[reference] = client.get(reference).status_code
    missing = [(reference, seen[reference]) for reference in references if seen[reference] != 200]
    report.expect(
        not missing,
        "GET %s: %d of the %d assets it loads are not served (%s)"
        % (url, len(missing), len(references), ", ".join("%s -> HTTP %d" % pair for pair in missing)),
    )
    return len(references)


def check_page(report, client, url, path):
    # Every exported page exists, so asking for it answers 200 — including
    # 404.html, which is a real file. A path that does not exist is what gets
    # that page's contents with a 404 status (see check_missing_page).
    document = path.read_text(encoding="utf-8")
    response = client.get(url)
    label = "GET %s" % url
    if not report.expect(
        response.status_code == 200, "%s: HTTP %d, expected 200" % (label, response.status_code)
    ):
        return
    report.expect(
        response.headers.get("content-type", "").startswith("text/html"),
        "%s: Content-Type is %r, expected text/html"
        % (label, response.headers.get("content-type")),
    )
    report.expect(response.text == document, "%s: the bytes served are not the file on disk" % label)
    csp = check_headers(report, label, response, "no-cache")

    script_src = csp.get("script-src", [])
    unsafe = [source for source in script_src if source.lower() in UNSAFE]
    report.expect(not unsafe, "%s: script-src allows %s" % (label, ", ".join(unsafe)))
    hashes = expected_hashes(document)
    listed = ["'%s'" % digest for digest in hashes]
    missing = [digest for digest in listed if digest not in script_src]
    report.expect(
        not missing,
        "%s: CSP script-src does not list %d of the %d inline scripts this page runs (%s)"
        % (label, len(missing), len(hashes), ", ".join(missing)),
    )
    extra = [source for source in script_src if source.startswith("'sha256-") and source not in listed]
    report.expect(
        not extra,
        "%s: CSP script-src lists %d hash(es) that match no inline script in the page (%s)"
        % (label, len(extra), ", ".join(extra)),
    )
    report.expect(
        "'self'" in script_src,
        "%s: CSP script-src does not allow 'self', so the build's own chunks cannot load" % label,
    )
    return len(hashes)


def check_asset(report, client, url, path):
    response = client.get(url)
    label = "GET %s" % url
    if not report.expect(response.status_code == 200, "%s: HTTP %d, expected 200" % (label, response.status_code)):
        return
    expected_type = {".js": ("text/javascript", "application/javascript"), ".css": ("text/css",)}[path.suffix]
    content_type = response.headers.get("content-type", "").split(";")[0].strip()
    report.expect(
        content_type in expected_type,
        "%s: Content-Type is %r, expected one of %r" % (label, content_type, expected_type),
    )
    report.expect(response.content == path.read_bytes(), "%s: the bytes served are not the file on disk" % label)
    check_headers(report, label, response, "public, max-age=31536000, immutable")


def check_missing_page(report, client, export_dir):
    url = "/app/not-a-real-page-a7f3/"
    response = client.get(url)
    label = "GET %s" % url
    if not report.expect(
        response.status_code == 404, "%s: HTTP %d, expected 404" % (label, response.status_code)
    ):
        return
    report.expect(
        response.headers.get("content-type", "").startswith("text/html"),
        "%s: Content-Type is %r, expected the export's HTML 404 page"
        % (label, response.headers.get("content-type")),
    )
    csp = check_headers(report, label, response, "no-cache")
    not_found = export_dir / "404.html"
    if not_found.is_file():
        document = not_found.read_text(encoding="utf-8")
        report.expect(response.text == document, "%s: did not serve the export's 404.html" % label)
        listed = ["'%s'" % digest for digest in expected_hashes(document)]
        report.expect(
            all(digest in csp.get("script-src", []) for digest in listed),
            "%s: the 404 page's inline scripts are not all in its CSP" % label,
        )


def check_api_requires_token(report, client):
    for method, path in API_ROUTES:
        response = client.request(method, path)
        label = "%s %s without a token" % (method, path)
        if not report.expect(
            response.status_code == 401, "%s: HTTP %d, expected 401" % (label, response.status_code)
        ):
            continue
        try:
            body = response.json()
        except ValueError:
            body = None
        report.expect(
            isinstance(body, dict) and isinstance(body.get("error"), str) and body["error"].strip(),
            "%s: body is %r, expected a JSON object with an error message" % (label, body),
        )
        report.expect(
            response.headers.get("Cache-Control") == "no-store",
            "%s: Cache-Control is %r, expected no-store" % (label, response.headers.get("Cache-Control")),
        )
        report.expect(
            response.headers.get("X-Content-Type-Options") == "nosniff",
            "%s: X-Content-Type-Options is %r, expected nosniff"
            % (label, response.headers.get("X-Content-Type-Options")),
        )


def main_cli():
    if not (EXPORT / "index.html").is_file():
        print("FAIL: no export at %s — run `npm run build` in frontend/ first." % EXPORT)
        return 1

    report = Report()
    pages = page_urls(EXPORT)
    assets = static_assets(EXPORT)
    if not report.expect(bool(pages), "the export contains no HTML pages"):
        print("FAIL: %s has no HTML pages." % EXPORT)
        return 1
    report.expect(bool(assets), "the export contains no _next/static assets to check")

    hashed = 0
    referenced = {}
    with isolated_backend(EXPORT):
        client = TestClient(main.app, raise_server_exceptions=False, follow_redirects=False)
        redirect = client.get("/app")
        report.expect(
            redirect.status_code == 307 and redirect.headers.get("location", "").endswith("/app/"),
            "GET /app: HTTP %d to %r, expected a 307 to /app/"
            % (redirect.status_code, redirect.headers.get("location")),
        )
        for url, path in pages:
            hashed += check_page(report, client, url, path) or 0
            check_references(report, client, url, path.read_text(encoding="utf-8"), referenced)
        for url, path in assets:
            check_asset(report, client, url, path)
        check_missing_page(report, client, EXPORT)
        check_api_requires_token(report, client)

    print("Export:       %s" % EXPORT)
    print("Pages:        %d checked, %d inline scripts hashed into their CSP" % (len(pages), hashed))
    print("Assets:       %d checked under _next/static" % len(assets))
    print("References:   %d distinct /app URLs the pages load, all resolved" % len(referenced))
    print("API routes:   %d checked for 401 without a pairing token" % len(API_ROUTES))
    print("Checks:       %d" % report.checks)
    if report.failures:
        print("\nFAILED (%d):" % len(report.failures))
        for failure in report.failures:
            print("  - %s" % failure)
        return 1
    print("\nOK: the export is served correctly, with hashed-script CSP and no unauthenticated API.")
    return 0


if __name__ == "__main__":
    sys.exit(main_cli())
