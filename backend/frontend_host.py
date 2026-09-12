"""Hosts the exported frontend (frontend/out) at /app with strict security headers.

The Next.js static export inlines its bootstrap scripts into every page, so a
`script-src 'self'` policy alone would block them, and `'unsafe-inline'` would
equally allow a script injected into the page. Instead each HTML document gets
a Content-Security-Policy whose script-src lists the sha256 hash of exactly the
inline scripts in that file: they run, and nothing else inline does. Hashes are
cached per file and recomputed when its size or mtime changes.

Inline scripts are found with a tokenizer that follows the HTML spec wherever it
changes what a browser hashes: comments and raw-text elements hide tags, script
text ends only at a real `</script>` (including the `<!--` escaped states), and
newlines are normalized before hashing as the browser's input stream does. Only
scripts the browser would run are hashed — no `src`, and an absent or empty
type, a JavaScript MIME type, `module`, `importmap`, or `speculationrules`.

The Python CI job never builds Node, so when the export is missing a small
built-in page explains how to build it, under the same headers.
"""

from __future__ import annotations

import base64
import hashlib
import html
import os
from pathlib import Path

from starlette.exceptions import HTTPException
from starlette.responses import FileResponse, HTMLResponse, PlainTextResponse, RedirectResponse
from starlette.staticfiles import StaticFiles

SECURITY_HEADERS = {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}

REVALIDATE = "no-cache"
IMMUTABLE = "public, max-age=31536000, immutable"

FALLBACK_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Imperium: frontend not built</title>
<style>
  body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b0d10; color: #e6e8eb; }
  main { max-width: 34rem; margin: 0 auto; padding: 3rem 1.5rem; }
  h1 { font-size: 1.35rem; margin: 0 0 1rem; }
  pre { background: #161a1f; border: 1px solid #262b31; border-radius: 8px; padding: 0.9rem 1rem; overflow-x: auto; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9rem; }
  p { color: #aab1b8; }
</style>
</head>
<body>
<main>
<h1>The Imperium frontend has not been built</h1>
<p>The backend is running, but <code>frontend/out</code> does not exist yet. Build the phone app once from the project root, then reload this page:</p>
<pre>cd frontend && npm ci && npm run build</pre>
<p>The API is unaffected and still requires the pairing token.</p>
</main>
</body>
</html>
"""

# HTML spec "JavaScript MIME type essence" strings.
_JAVASCRIPT_TYPES = frozenset(
    {
        "application/ecmascript", "application/javascript", "application/x-ecmascript",
        "application/x-javascript", "text/ecmascript", "text/javascript",
        "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
        "text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript",
        "text/livescript", "text/x-ecmascript", "text/x-javascript",
    }
)

# Newlines are already normalized to \n before tokenizing.
_WHITESPACE = "\t\n\f "

# Elements whose content the tokenizer reads as text until their end tag
# (RAWTEXT and RCDATA, with scripting enabled).
_TEXT_ELEMENTS = frozenset(
    {"style", "xmp", "iframe", "noembed", "noframes", "noscript", "textarea", "title"}
)


def content_security_policy(script_hashes=()) -> str:
    script_src = " ".join(["'self'"] + [f"'{digest}'" for digest in script_hashes])
    return "; ".join(
        [
            "default-src 'self'",
            f"script-src {script_src}",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "font-src 'self'",
            "connect-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ]
    )


def _is_alpha(ch: str) -> bool:
    return ch.isascii() and ch.isalpha()


def _read_tag(text: str, i: int) -> tuple:
    """Parse a tag from the first letter of its name through its '>'.

    Returns (name, attributes, end); end is None when the document ends inside
    the tag, in which case the browser drops the tag.
    """
    n = len(text)
    j = i
    while j < n and text[j] not in _WHITESPACE + "/>":
        j += 1
    name = text[i:j].lower()
    attributes: dict[str, str] = {}
    while j < n:
        ch = text[j]
        if ch in _WHITESPACE or ch == "/":
            j += 1
            continue
        if ch == ">":
            return name, attributes, j + 1
        # The first character always belongs to the name, even "=".
        k = j + 1
        while k < n and text[k] not in _WHITESPACE + "/>=":
            k += 1
        attribute = text[j:k].lower()
        j = k
        while j < n and text[j] in _WHITESPACE:
            j += 1
        value = ""
        if j < n and text[j] == "=":
            j += 1
            while j < n and text[j] in _WHITESPACE:
                j += 1
            if j < n and text[j] in "\"'":
                close = text.find(text[j], j + 1)
                if close == -1:
                    return name, attributes, None
                value, j = text[j + 1 : close], close + 1
            else:
                k = j
                while k < n and text[k] not in _WHITESPACE + ">":
                    k += 1
                value, j = text[j:k], k
        # A repeated attribute is ignored; the first one wins.
        attributes.setdefault(attribute, html.unescape(value))
    return name, attributes, None


def _end_tag_at(text: str, i: int, name: str) -> bool:
    """Whether `</name` followed by whitespace, '/', or '>' starts at i."""
    end = i + 2 + len(name)
    return (
        text.startswith("</", i)
        and text[i + 2 : end].lower() == name
        and end < len(text)
        and text[end] in _WHITESPACE + "/>"
    )


def _start_tag_at(text: str, i: int, name: str) -> bool:
    end = i + 1 + len(name)
    return (
        text.startswith("<", i)
        and text[i + 1 : end].lower() == name
        and end < len(text)
        and text[end] in _WHITESPACE + "/>"
    )


def _after_tag(text: str, i: int) -> int:
    """The position after the end tag starting at i."""
    _, _, end = _read_tag(text, i + 2)
    return len(text) if end is None else end


def _comment_end(text: str, i: int) -> int:
    """The position after a comment whose `<!--` ends at i."""
    if text.startswith(">", i):
        return i + 1
    if text.startswith("->", i):
        return i + 2
    ends = [p for p in (text.find("-->", i), text.find("--!>", i)) if p != -1]
    if not ends:
        return len(text)
    p = min(ends)
    return p + (3 if text.startswith("-->", p) else 4)


def _text_element_end(text: str, i: int, name: str) -> tuple[int, int]:
    """(where the text ends, where parsing resumes) for a RAWTEXT or RCDATA element."""
    j = i
    while True:
        lt = text.find("</", j)
        if lt == -1:
            return len(text), len(text)
        if _end_tag_at(text, lt, name):
            return lt, _after_tag(text, lt)
        j = lt + 1


def _script_end(text: str, i: int) -> tuple[int, int]:
    """(where the script text ends, where parsing resumes), per the script data states.

    Inside `<!--`, a `<script` opens a "double escaped" section in which
    `</script>` does not close the element; `-->` returns to plain script data.
    """
    n = len(text)
    state = "data"
    j = i
    while j < n:
        if state == "data":
            lt = text.find("<", j)
            if lt == -1:
                break
            if _end_tag_at(text, lt, "script"):
                return lt, _after_tag(text, lt)
            if text.startswith("<!--", lt):
                state, j = "escaped_dash_dash", lt + 4
            else:
                j = lt + 1
            continue
        ch = text[j]
        if state.startswith("escaped"):
            if ch == "<":
                if _end_tag_at(text, j, "script"):
                    return j, _after_tag(text, j)
                if _start_tag_at(text, j, "script"):
                    state, j = "double", j + len("<script") + 1
                else:
                    state, j = "escaped", j + 1
                continue
            if ch == "-":
                state = "escaped_dash" if state == "escaped" else "escaped_dash_dash"
            elif ch == ">" and state == "escaped_dash_dash":
                state = "data"
            else:
                state = "escaped"
        else:
            if ch == "<":
                if _end_tag_at(text, j, "script"):
                    state, j = "escaped", j + len("</script") + 1
                else:
                    state, j = "double", j + 1
                continue
            if ch == "-":
                state = "double_dash" if state == "double" else "double_dash_dash"
            elif ch == ">" and state == "double_dash_dash":
                state = "data"
            else:
                state = "double"
        j += 1
    return n, n


def _input_stream(document: str) -> str:
    """The text a browser tokenizes and hashes.

    The input stream normalizes newlines, and script data turns NUL into U+FFFD,
    before anything is tokenized.
    """
    return document.replace("\r\n", "\n").replace("\r", "\n").replace("\0", "\ufffd")


def inline_scripts(document: str) -> list[tuple[dict, str]]:
    """Every script element's attributes and exact text, in document order."""
    text = _input_stream(document)
    scripts: list[tuple[dict, str]] = []
    n = len(text)
    i = 0
    while True:
        lt = text.find("<", i)
        if lt == -1 or lt + 1 >= n:
            break
        nxt = text[lt + 1]
        if text.startswith("<!--", lt):
            i = _comment_end(text, lt + 4)
        elif nxt in "!?" or (nxt == "/" and lt + 2 < n and not _is_alpha(text[lt + 2])):
            # Doctypes, processing instructions, and malformed end tags are
            # bogus comments that end at the next '>'.
            gt = text.find(">", lt + 2)
            i = n if gt == -1 else gt + 1
        elif nxt == "/":
            i = _after_tag(text, lt)
        elif _is_alpha(nxt):
            name, attributes, end = _read_tag(text, lt + 1)
            if end is None:
                break
            i = end
            if name == "script":
                text_end, i = _script_end(text, end)
                scripts.append((attributes, text[end:text_end]))
            elif name == "plaintext":
                break
            elif name in _TEXT_ELEMENTS:
                _, i = _text_element_end(text, end, name)
        else:
            i = lt + 1
    return scripts


def executes(attributes: dict) -> bool:
    """Whether a browser runs a script element's inline text (HTML "prepare the script element")."""
    if "src" in attributes:
        return False
    if "type" in attributes:
        if attributes["type"] == "":
            return True
        type_string = attributes["type"].strip(_WHITESPACE).lower()
    elif attributes.get("language"):
        type_string = "text/" + attributes["language"].lower()
    else:
        return True
    if type_string in ("module", "importmap", "speculationrules") or type_string in _JAVASCRIPT_TYPES:
        return True
    # Browsers differ on MIME parameters ("text/javascript; charset=utf-8"). An
    # extra hash only permits text already in this file, so count such scripts.
    return ";" in type_string and type_string.split(";", 1)[0].strip(_WHITESPACE) in _JAVASCRIPT_TYPES


def script_hashes(document: str) -> list[str]:
    """CSP sha256 sources for the inline scripts a browser would run, in order, without repeats."""
    hashes: list[str] = []
    for attributes, source in inline_scripts(document):
        if not source or not executes(attributes):
            continue
        digest = base64.b64encode(hashlib.sha256(source.encode("utf-8")).digest()).decode("ascii")
        token = f"sha256-{digest}"
        if token not in hashes:
            hashes.append(token)
    return hashes


def secure(response, script_hashes=(), cache_control: str = REVALIDATE):
    response.headers.update(SECURITY_HEADERS)
    response.headers["Content-Security-Policy"] = content_security_policy(script_hashes)
    response.headers["Cache-Control"] = cache_control
    return response


class _ExportFiles(StaticFiles):
    """StaticFiles that records which file a 200 or 304 response is for."""

    def file_response(self, full_path, stat_result, scope, status_code=200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        response.served_file = (str(full_path), stat_result)
        return response


class FrontendHost:
    """The /app mount: the static export when it is built, otherwise the fallback page."""

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        self._files: _ExportFiles | None = None
        self._hash_cache: dict[str, tuple] = {}

    def _export_files(self) -> _ExportFiles:
        if self._files is None or self._files.directory != str(self.directory):
            self._files = _ExportFiles(directory=str(self.directory), html=True, check_dir=False)
        return self._files

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            return
        files = self._export_files()
        path = files.get_path(scope)
        if scope["method"] not in ("GET", "HEAD"):
            response = secure(PlainTextResponse("Method Not Allowed", status_code=405))
        elif not (self.directory / "index.html").is_file():
            status = 200 if path in (".", "index.html") else 404
            response = secure(HTMLResponse(FALLBACK_PAGE, status_code=status))
        else:
            try:
                response = await files.get_response(path, scope)
            except HTTPException as exc:
                response = PlainTextResponse(str(exc.detail), status_code=exc.status_code)
            self._secure_export(response, path)
        await response(scope, receive, send)

    def _secure_export(self, response, path: str) -> None:
        served = getattr(response, "served_file", None)
        if served is None and isinstance(response, FileResponse):
            # The export's 404.html, served for any path that does not exist.
            served = (str(response.path), response.stat_result)
        if served is not None and served[0].lower().endswith((".html", ".htm")):
            secure(response, self._hashes_for(*served))
            return
        # Next.js puts a content hash in every file name under _next/static, so a
        # successful response there never changes and may be cached for good.
        immutable = path.replace(os.sep, "/").startswith("_next/static/") and response.status_code < 400
        secure(response, cache_control=IMMUTABLE if immutable else REVALIDATE)

    def _hashes_for(self, full_path: str, stat_result: os.stat_result) -> list[str]:
        key = (stat_result.st_mtime_ns, stat_result.st_size)
        cached = self._hash_cache.get(full_path)
        if cached is not None and cached[0] == key:
            return cached[1]
        with open(full_path, "rb") as f:
            hashes = script_hashes(f.read().decode("utf-8", errors="replace"))
        self._hash_cache[full_path] = (key, hashes)
        return hashes

    def redirect(self, url: str) -> RedirectResponse:
        return secure(RedirectResponse(url, status_code=307))
