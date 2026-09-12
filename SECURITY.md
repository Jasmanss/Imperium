# Security Model

Imperium executes real actions on a Mac from natural-language input. That
makes it, by construction, a remote-execution surface — so the security
layer is not an add-on, it is the core design constraint. This document
describes the threat model and the mitigations.

## Threat model

| # | Threat | Vector |
|---|--------|--------|
| 1 | Attacker on the same network drives the Mac | Unauthenticated HTTP API |
| 2 | Model misinterprets a command and does something harmful | LLM-generated AppleScript |
| 3 | Generated script escapes to the shell or touches credentials | `do shell script`, keychain access |
| 4 | A harmful action executes before the user can react | Outward-facing actions (email, iMessage, git push) |
| 5 | No way to know what the agent actually did | Missing audit trail |
| 6 | A generated script sends mail or messages without confirmation | Phrasing that avoids the destructive-command classifier |
| 7 | A command's text breaks out of a built-in handler's AppleScript | Unescaped values interpolated into handler templates |
| 8 | A retried script repeats an effect it already had | Re-running after a runtime error or timeout |
| 9 | Another site frames the app and tricks the user into tapping Confirm | Clickjacking the hosted frontend |
| 10 | An injected script reads the pairing token from localStorage | Script injection into the `/app` pages |
| 11 | The token or command data is kept or seen outside the paired app | URLs, browser history, `Referer` headers, cached API responses, the event stream |
| 12 | A client ties up the server through the live stream | Held-open or unread `GET /events` connections |
| 13 | A cancelled command can still be confirmed | A cancel that hides a parked command without revoking its id |
| 14 | The phone cannot cancel while a command runs, or two commands drive the GUI at once | Blocking handlers on the event loop; concurrent execution |

## Mitigations

### 1. Pairing-token authentication (`security.py`)

Every endpoint except the health check and the static frontend requires a
Bearer token. The token is generated on first run (`~/.imperium/token`,
mode 0600) and delivered to the phone via a QR code printed in the Mac
terminal. The token travels in the URL *fragment*, which browsers never
send over the network, and is stored in the phone's localStorage. The app
stores it before any request goes out, then removes the fragment from the
address bar and the current history entry with `history.replaceState`. From
then on the token is only ever sent as an `Authorization` header, never in a
URL; a token in the query string is rejected. Comparison uses
`hmac.compare_digest` (constant-time). Revoke by deleting the token file and
restarting.

Auth is enforced in middleware — **deny by default**: a newly added route
is authenticated unless explicitly listed as public. That includes the live
event stream (`GET /events`). `EventSource` cannot send headers, so the app
reads the stream with `fetch` rather than putting the token in its URL, and a
rejected request is refused before it takes a subscriber slot.

Every response from an authenticated route, and every 401, carries
`Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, so commands,
scripts, and audit data are never stored by a browser or proxy or
reinterpreted as another content type.

### 2. Single gated entry point (`main.py`)

Action handlers (email, iMessage, git, Spotify, project generation) are
internal functions, not HTTP routes. The only ways to trigger an action are
`POST /text-command` — which classifies and permission-checks every command
— and `POST /confirm/{id}` for commands the user has explicitly approved.
The routes v3 adds cannot start one: `DELETE /pending/{id}` only revokes a
parked command, and `GET /pending` and `GET /events` only read state.

### 3. Tiered permissions with confirm-before-destructive (`permissions.py`)

Commands are classified into categories, each mapped to a tier:

- `read` → auto-execute (observing state)
- `act` → auto-execute (reversible: open apps, play music, type)
- `destructive` → **requires an explicit Confirm tap on the phone**
  (send email/iMessage, git push, quit all apps)

Destructive commands are parked server-side with a 120-second TTL and a
single-use id. Nothing about the pending action is trusted from the client:
confirming only replays the server-stored command. Tiers and category
mappings are configurable in `~/.imperium/permissions.json`.

Cancelling (`DELETE /pending/{id}`) claims the id through the same single-use
`pop_pending` as confirming, so whichever arrives first wins: a cancelled id
can never be confirmed, and nothing runs. Confirming or cancelling an unknown
or expired id changes nothing — no audit row, no event — and leaves other
parked commands untouched. `GET /pending` lists only unexpired entries.

The phone shows what a parked command will do before the user confirms: the
recipient and message, the email subject and attachment, the repository a
push targets, or that every app except Finder will quit. These details come
only from the handlers' own regex parsers, so parking never looks a name up in
Contacts, reads the disk, or runs a process; a named recipient is shown as
typed and resolved in Contacts only after Confirm.

### 4. Script policy gate (`policy_gate.py`)

Model-generated AppleScript is never executed raw. Every script the model
writes — including every script the repair loop produces — is policy-checked
before it is validated or run, and a policy block is terminal: the repair loop
never asks the model to rewrite a blocked script.

The checks run against what AppleScript will actually execute. A small lexer
mirrors AppleScript's rules for string literals, `--` and `#` line comments
(which end at a carriage return as well as a line feed), nested `(* *)` block
comments, and `¬` line continuations, so quotes inside
comments cannot hide code, and words inside user-facing text (an email that
mentions "password reset") do not trigger false blocks.

- **Banned constructs:** `do shell script`, `run`/`load`/`store script`, and
  raw `«event …»` codes (all shell escape hatches), `sudo`, raw file access,
  browser JavaScript execution, file deletion and moving to trash,
  password/keychain references, power and session control, disk operations.
- **App allowlist:** applications and processes must be named with string
  literals; a variable, index, or expression is refused because it cannot be
  checked. Every literal name must be allowlisted, whether it appears in
  `tell`/`activate`/`launch application`, `application file`, a System Events
  `process "X"`, a process-name filter, or a quoted `.app` bundle path (POSIX
  or HFS). Bundle ids are refused outright, and partial-name process filters
  that could match a terminal or settings app are rejected.
- **Outward-facing actions:** a script that tells Mail or Messages to send,
  forward, or redirect only runs when the user confirmed the command on their
  phone. Confirmation is carried in a per-request context variable set only by
  `POST /confirm/{id}`, so rephrasing a command to dodge the destructive
  classifier still cannot make a generated script send anything unconfirmed.

### 5. Built-in handlers (`main.py`)

Spotify, iMessage, email, Contacts lookup, Chrome tabs, and quit-all run fixed
AppleScript templates rather than model output, so they do not pass through
the policy gate. Every value taken from the user's command is quoted with
`policy_gate.applescript_literal`, and the offline evals check that a crafted
value — one that closes the string and appends `do shell script` — stays
inside its literal.

### 6. Repair loop (`main.py`)

A failed model script is repaired at most twice. A runtime failure is not
re-run after a timeout or for a confirmed command, because earlier lines may
already have had an outward effect such as sending a message; in those cases
only syntax errors, which AppleScript reports before running anything, are
repaired.

### 7. Append-only audit log (`audit.py`)

Every command, classification, policy decision, confirmation or
cancellation, execution result, and blocked script is recorded in SQLite
(`~/.imperium/audit.db`) with timestamps, durations, token usage, and the
AppleScript each command executed, whether model-generated or a handler
template. Every row a command writes carries its `command_id`, so its
parking, confirmation or cancellation, blocked scripts, and result read back
together. A command that crashes is still recorded as failed. `GET /audit`
(paged with `before_id`, filtered by `decision` or `command_id` through bound
SQL parameters, at most 200 rows a page) and `GET /stats` (both
authenticated) return entries and aggregates.

### 8. Serialized command worker (`main.py`)

A command that has passed the permission gate runs on a single worker thread
(`ThreadPoolExecutor(max_workers=1)`), never on the event loop and never
alongside another command. Handlers block in `subprocess.run` and
`time.sleep`, so on the event loop they would freeze the whole server —
cancel, `GET /pending`, and the live stream included — for as long as a
command ran. Commands also drive the GUI, so two at once could send one
command's keystrokes to an app the other just brought forward.

Each command runs inside a copy of its request's context, so the confirmed
flag set by `POST /confirm/{id}` (section 4) reaches the worker, while the
next command on the same thread starts unconfirmed with a fresh trace. The
`started` event, trace, audit row, and `finished` event are all produced on
the worker: a queued command is never reported as started, and a command that
has started is still audited if its HTTP request goes away.

### 9. Live event stream (`events.py`)

`GET /events` streams what the agent is doing as Server-Sent Events: each
command's arrival, parking, confirmation or cancellation, start, model calls,
scripts, repairs, policy blocks, and result. Events carry command text and
script previews, so the stream is authenticated like every other API route
(section 1). They are built from command state, never from request headers,
so they cannot carry the pairing token, and the opening `hello` frame carries
only a boot id and the server time. A request's `client_id` is echoed into
its events only when it matches `[A-Za-z0-9_-]{1,64}`; anything else becomes
null.

- **Subscriber cap:** at most 8 streams are open at once; a ninth request
  gets HTTP 429. A slot is released however the stream ends, including a
  stream cancelled before its body started.
- **Bounded queues:** publishing never waits on a reader. Each stream has a
  queue of 64 events, and a subscriber that stops reading until its queue
  overflows is dropped instead of letting memory grow.
- **Replay:** the last 200 events are kept in a ring buffer, and a client
  that reconnects with `Last-Event-ID` receives the buffered events after that
  id. The queue is smaller than the buffer, so a dropped subscriber that
  reconnects promptly replays everything it missed. Registration and the
  replay snapshot happen under one lock, so no event is missed or sent twice.
- **Boot-scoped replay:** event ids start at the boot's start time in
  microseconds, so an id from an earlier boot is always below the current
  boot's first id. Replay only starts from an id this boot issued; an earlier
  boot's id, an id never issued, or a malformed value replays nothing, and the
  new `boot_id` in `hello` tells the client the server restarted.

### 10. Hosted frontend (`frontend_host.py`, `frontend/`)

The phone app is a Next.js static export (`frontend/out`) served by the
backend at `/app`, on the same origin as the API, so CORS is never opened.
`/app` is public, like the v2 page, because it is useless without a paired
token; it answers only GET and HEAD. Every `/app` response — pages, assets,
404s, 405s, redirects, and the fallback page — carries these headers:

- **Content-Security-Policy:** `default-src 'self'`, `connect-src 'self'`,
  `img-src 'self' data:`, `font-src 'self'`, `object-src 'none'`,
  `base-uri 'none'`, `form-action 'self'`, and `frame-ancestors 'none'`.
  Styles may be inline (`style-src 'self' 'unsafe-inline'`); scripts may not.
- **Per-page script hashes:** the export inlines its bootstrap scripts into
  every page, so `script-src 'self'` alone would block them, and
  `'unsafe-inline'` would equally allow an injected script. Instead each HTML
  document's `script-src` lists `'self'` and the sha256 hash of exactly the
  inline scripts in that file a browser would run. They are found by a
  tokenizer that follows the HTML spec wherever it changes what a browser
  hashes: comments and raw-text elements (`<title>`, `<textarea>`,
  `<noscript>`, `<style>`, …) hide tags, script text ends only at a real
  `</script>` (including the `<!--` escaped states), and newlines are
  normalized before hashing. Only scripts that run are hashed: no `src`, and
  an absent or empty type, a JavaScript MIME type, `module`, `importmap`, or
  `speculationrules`. Hashes are cached per file and recomputed when its size
  or mtime changes, so a rebuild takes effect without a restart.
- **Framing, sniffing, referrer, features:** `X-Frame-Options: DENY`
  alongside `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, and
  `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- **Caching:** pages revalidate on every load (`no-cache`); only successful
  responses under `_next/static/`, whose file names carry a content hash, are
  cached as immutable.

The app renders every server value — command text, script previews, errors,
audit rows — as React text; nothing uses `dangerouslySetInnerHTML`. It makes
no third-party requests (no external fonts, scripts, images, or analytics):
every API call and the event stream use same-origin relative paths, which
`connect-src 'self'` enforces as well. When `frontend/out` has not been built,
`/app` serves a built-in page with build instructions under the same headers.

## Verification

Every mitigation above is covered by the offline eval suite in `evals/`,
which runs without an API key and intercepts every process spawn, keystroke,
and model call, including while the backend is imported and on the command
worker thread. The suite is itself mutation-tested: `evals/runner.py`
deliberately breaks each safety property in memory (auth bypass, skipped
confirmation, replayable or non-expiring confirmations, a disabled gate,
allowlist, lexer, or handler escaping, unconfirmed sends, re-running confirmed
commands, and more) and fails unless the suite detects every one. Results are
in `evals/RESULTS.md`.

The v3 surface is covered the same way. Each task gets its own token, audit
database, event bus, command worker, and an unbuilt frontend export
directory, and the harness waits for the worker to finish before restoring
the real paths. Stream and worker tasks drive the ASGI app directly with a
timeout on every read, because an endless event stream never returns through
`TestClient`. The tasks check that:

- **Auth:** `GET /pending`, `DELETE /pending/{id}`, and `GET /events` refuse
  requests without a valid token — the stream for six kinds of bad auth,
  including a token in the query string, without taking a subscriber slot —
  and a refused cancel leaves the command confirmable. API responses and 401s
  both carry `Cache-Control: no-store` and `nosniff`.
- **Confirm and cancel:** a parked response describes the command (a
  12-character hex `command_id`, `expires_at` equal to its creation time plus
  the TTL, and details) and matches its `pending` event and audit row; details
  for a text, an email, a git push, and quit-all never call Contacts or
  execute anything; a malformed `client_id` is dropped from both the response
  and the event; a cancelled id can be neither confirmed nor cancelled again,
  is no longer listed, and never runs; an unknown or expired id writes no
  audit row, publishes no event, and leaves other parked commands alone;
  `GET /pending` lists only unexpired entries, oldest first; and one command
  keeps the same `command_id` and `client_id` across its responses, audit
  rows, and events.
- **Event bus and stream:** events published from two threads reach every
  subscriber in order; replay honors only `Last-Event-ID` values this boot
  issued, without repeating a live event; a ninth subscriber is refused (HTTP
  429 on the route) and a closed stream frees its slot; a subscriber that
  stops reading is dropped while one that keeps up loses nothing, and
  reconnecting replays everything the dropped one missed; the buffer keeps
  the last 200 events; and the stream opens with `hello`, sends well-formed
  frames with exactly each event type's fields for a clean, a repaired, a
  policy-blocked, and a parked-then-cancelled command, never contains the
  pairing token, and sends a ping while idle.
- **Command worker:** two commands never overlap, run on the same worker
  thread, and are reported as started only when they start; the event
  stream, `GET /pending`, cancel, and `GET /audit` all answer while a command
  is blocked; and a confirmed command keeps its confirmation and trace on the
  worker, while the next command inherits neither.
- **Hosted frontend:** against a temporary export whose pages include
  scripts with `src`, JSON and `text/plain` scripts, a `vbscript` `language`
  attribute, scripts inside a comment, `<title>`, `<textarea>`, and
  `<noscript>`, CRLF line endings, uppercase tags, `>` inside an attribute, a
  `<!--<script>` block nested in a script, and empty and duplicate scripts,
  each page's `script-src` is exactly `'self'` plus the hashes of the scripts
  a browser runs — computed from the fixture's own declarations, not by the
  tokenizer under test — with no `unsafe-inline`, `unsafe-eval`, or
  `unsafe-hashes`. Every page, asset, 404, 405, and redirect carries
  `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, and the
  framing, sniffing, referrer, and permissions headers; only hashed assets
  that exist are cached as immutable; a rebuilt page gets new hashes; and
  with no export the fallback page is served under the same headers, and a
  later build takes effect without a restart.
- **Audit and stats:** a v2-era database gains the `command_id` and `action`
  columns; `GET /audit` pages correctly, including an exactly full last page,
  applies its filters, returns nothing for a SQL-injection-style filter
  value, and clamps its limit to 1–200; and stats count confirmations and
  cancellations.

The new mutations break each of these properties, and every one must be
caught: `command_id` and `action` added only to new audit databases, ignored
audit filters, a last full page that points past the end, cacheable API
responses, a public event stream, a cancel that does not revoke,
`GET /pending` listing expired entries, parking that looks up the recipient in
Contacts, an unvalidated `client_id`, commands run concurrently or on the
event loop, a worker that drops the confirmed context, replay that ignores
`Last-Event-ID` or the boot, uncapped or never-dropped subscribers, a
subscriber queue larger than the replay buffer, a `hello` frame carrying the
pairing URL, a CSP that allows inline scripts or framing, and a CSP tokenizer
that hashes scripts a browser never runs, does not let comments hide scripts,
skips newline normalization, or ends script text at the first `</script>`.

Building the evals, and then an adversarial review of the result, surfaced
real vulnerabilities. All are fixed and pinned by regression tasks:

- `run script "do shell script \"…\""` evaluated a string as AppleScript,
  escaping the `do shell script` ban.
- The allowlist only recognised `tell application "X"`; `activate`/`launch
  application`, `application id`, `tell process`, process-name filters, and
  Finder opening `Terminal.app` all bypassed it.
- Sending mail or messages was gated only by how the user phrased the
  command; a script generated from other phrasing could send unconfirmed.
- The gate paired quotes without understanding comments, so `send` or
  `do shell script` placed between two `-- "` comment lines was invisible to
  it. `application file id`, HFS paths ending in `.app:`, raw `«event»` codes,
  `¬` continuations, apps named through variables, and code placed after a
  comment ended by a classic-Mac carriage return also got past.
- The Spotify, iMessage, and Contacts handlers escaped quotes but not
  backslashes (Contacts escaped nothing), so a command such as
  `play x\" & (do shell script …) -- on Spotify` compiled to a shell call. That
  command is act-tier, so it ran with no confirmation.
- The repair loop re-ran scripts after runtime errors, which could repeat a
  confirmed send.

## Deployment guidance

- **Run over Tailscale** rather than exposing the LAN port: encrypted
  transport, works away from home, and the port is never publicly
  reachable. Never port-forward 8000 to the internet.
- The frontend is a static export served same-origin from the backend at
  `/app`, so no CORS exceptions exist. Build it from the project root with
  `cd frontend && npm ci && npm run build`, and again after changing it.

## Known limitations (v3 scope)

- Single-user, single-token model — no per-device tokens or rotation yet.
  Every device and tab holding the token shares the same eight event-stream
  slots; a ninth stream gets HTTP 429 until one closes, though commands still
  work without it.
- The pairing token in localStorage is readable by any script running on the
  app's origin. The Content-Security-Policy exists to keep such a script from
  running: only the export's own hashed inline scripts and same-origin script
  files execute. It does not stop someone who can rewrite traffic — over plain
  HTTP they can replace the page and its headers — which is one more reason to
  run over Tailscale. Styles may still be inline, so markup injected into a
  page could restyle it, but the app renders server data only as text.
- The frontend must be built once before `/app` is usable; until then `/app`
  serves build instructions. The backend never builds it.
- Cancel revokes only a parked command. A command that has started on the
  worker cannot be stopped from the phone, and commands queued behind it wait
  their turn.
- Replay covers the last 200 events of the current boot. A client that missed
  more, or reconnects after a restart, gets no replay; parked commands are
  still listed by `GET /pending`.
- The Confirm card shows what the handlers' regex parsers understood, which is
  not always what the user meant. For "push MyProject to github" the git
  parser matches "Project" inside "MyProject", so the card names a folder
  matching "to github", falling back to the most recently changed repository
  on the Desktop. The card shows this faithfully, so the user can cancel.
- The policy gate is a static filter over untrusted text, not a sandbox.
  Known gaps: keystrokes sent through System Events go to whatever app is
  already frontmost; string concatenation can hide a `.app` bundle path handed
  to Finder (`"…/Terminal.a" & "pp"`); indirect file reads through variables
  are not detected; UI scripting can click buttons inside allowlisted apps
  (for example, a Send button in a web mail client open in Chrome). Defense in
  depth comes from the tier gate above it and the audit log below it. Closing
  these fully means replacing free-form AppleScript with a fixed set of typed
  actions.
- `step_executor.py`, `playwright_claude.py`, and the run-program helpers in
  `code_file_actions.py` run AppleScript or generated Python directly, but no
  route reaches them. They must go through the gate and the permission tiers
  before being connected.
- Opening an app by name through the app launcher is trusted code acting on
  the authenticated user's own request and is not filtered by the allowlist.
- Prompt-injection via content the agent reads (web pages, files) is
  mitigated only by the policy gate and destructive-tier confirmation;
  screen-awareness features (future) will require stronger isolation.
