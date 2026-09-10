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

LLM-generated AppleScript is never executed raw. Every script — including
every script the repair loop produces — passes a policy check at the single
execution choke point (`_osascript_pipe`). A policy block is terminal: the
repair loop never asks the model to rewrite a blocked script.

- **Banned constructs:** `do shell script` and `run`/`load`/`store script`
  (both are shell escape hatches), `sudo`, raw file access, browser
  JavaScript execution, file deletion and moving to trash, password/keychain
  references, power and session control, disk operations.
- **App allowlist:** every way a script can name an application must resolve
  to an allowlisted app — `tell application`, `activate`/`launch
  application`, bundle ids, System Events `process "X"`, process-name
  filters (partial-name filters that could match a terminal or settings app
  are rejected), and quoted `.app` bundle paths.
- **Outward-facing actions:** a script that tells Mail or Messages to send,
  forward, or redirect only runs when the user confirmed the command on their
  phone. Confirmation is carried in a per-request context variable set only by
  `POST /confirm/{id}`, so rephrasing a command to dodge the destructive
  classifier still cannot send anything unconfirmed.

String literals are stripped before pattern matching so user-facing text
(e.g. an email mentioning "password reset") does not trigger false blocks.

### 5. Append-only audit log (`audit.py`)

Every command, classification, policy decision, confirmation, execution
result, and blocked script is recorded in SQLite (`~/.imperium/audit.db`)
with timestamps and durations. `GET /audit` (authenticated) returns recent
entries.

## Verification

Every mitigation above is covered by the offline eval suite in `evals/`,
which runs without an API key and never touches the Mac. The suite is itself
mutation-tested: `evals/runner.py` deliberately breaks each safety property in
memory (auth bypass, skipped confirmation, replayable or non-expiring
confirmations, disabled policy gate or allowlist, unconfirmed sends, and more)
and fails unless the suite detects every one. Results are in
`evals/RESULTS.md`.

Building the eval suite surfaced real bypasses in the first version of the
policy gate, all now fixed and pinned by regression tasks:

- `run script "do shell script \"…\""` evaluated a string as AppleScript,
  escaping the `do shell script` ban (string literals are stripped before
  matching, so the inner command was invisible).
- The allowlist only recognised `tell application "X"`; `activate
  application`, `launch application`, `application id`, `tell process`,
  process-name filters, and Finder opening `Terminal.app` all bypassed it.
- Sending mail or messages was gated only by how the user phrased the
  command; a script generated from other phrasing could send unconfirmed.

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
  already frontmost; string concatenation (`"Term" & "inal"`) can hide an app
  name; indirect file reads through variables are not detected; UI scripting
  can click buttons inside allowlisted apps (for example, a Send button in a
  web mail client open in Chrome). Defense in depth comes from the tier gate
  above it and the audit log below it. Closing these fully means replacing
  free-form AppleScript with a fixed set of typed actions.
- Opening an app by name through the app launcher is trusted code acting on
  the authenticated user's own request and is not filtered by the allowlist.
- Prompt-injection via content the agent reads (web pages, files) is
  mitigated only by the policy gate and destructive-tier confirmation;
  screen-awareness features (future) will require stronger isolation.
