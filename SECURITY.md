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

## Mitigations

### 1. Pairing-token authentication (`security.py`)

Every endpoint except the health check and the static frontend requires a
Bearer token. The token is generated on first run (`~/.imperium/token`,
mode 0600) and delivered to the phone via a QR code printed in the Mac
terminal. The token travels in the URL *fragment*, which browsers never
send over the network, and is stored in the phone's localStorage.
Comparison uses `hmac.compare_digest` (constant-time). Revoke by deleting
the token file and restarting.

Auth is enforced in middleware — **deny by default**: a newly added route
is authenticated unless explicitly listed as public.

### 2. Single gated entry point (`main.py`)

Action handlers (email, iMessage, git, Spotify, project generation) are
internal functions, not HTTP routes. The only ways to trigger an action are
`POST /text-command` — which classifies and permission-checks every command
— and `POST /confirm/{id}` for commands the user has explicitly approved.

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

Every command, classification, policy decision, confirmation, execution
result, and blocked script is recorded in SQLite (`~/.imperium/audit.db`)
with timestamps, durations, token usage, and the AppleScript each command
executed, whether model-generated or a handler template. A command that
crashes is still recorded as failed. `GET /audit` and `GET /stats` (both
authenticated) return recent entries and aggregates.

## Verification

Every mitigation above is covered by the offline eval suite in `evals/`,
which runs without an API key and intercepts every process spawn, keystroke,
and model call, including while the backend is imported. The suite is itself
mutation-tested: `evals/runner.py` deliberately breaks each safety property in
memory (auth bypass, skipped confirmation, replayable or non-expiring
confirmations, a disabled gate, allowlist, lexer, or handler escaping,
unconfirmed sends, re-running confirmed commands, and more) and fails unless
the suite detects every one. Results are in `evals/RESULTS.md`.

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
- The frontend is served same-origin from the backend, so no CORS
  exceptions exist.

## Known limitations (v2 scope)

- Single-user, single-token model — no per-device tokens or rotation yet.
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
