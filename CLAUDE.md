# Working on Imperium

Imperium executes natural-language commands on the owner's Mac: a FastAPI
backend turns a command into AppleScript (built-in templates, or Claude for
anything else) and runs it, behind pairing-token auth, a tiered permission
model, a script policy gate, and an audit log. The phone client is a Next.js
static export the backend serves at `/app`.

Read [README.md](README.md) for the architecture and setup, and
[SECURITY.md](SECURITY.md) for the threat model — it is the spec for anything
touching auth, permissions, the policy gate, or script execution.

## Layout

- `backend/main.py` — routes, command classifier, built-in handlers, repair loop
- `backend/security.py` (auth), `permissions.py` (tiers, parked confirmations),
  `policy_gate.py` (script checks), `audit.py`, `tracing.py`, `events.py`
  (live stream), `frontend_host.py` (serves `frontend/out` with the CSP)
- `frontend/` — Next.js 16 + React 19 + Tailwind v4, static export to `frontend/out`
- `evals/` — `tasks.yaml`, `runner.py` (harness + mutations),
  `check_frontend_export.py`, `RESULTS.md` (generated)

## Commands

```bash
python3 evals/runner.py --no-write        # offline suite + mutation check (~35s, no API key)
python3 evals/runner.py                   # same, and regenerate evals/RESULTS.md
python3 evals/check_frontend_export.py    # serve the built export, check headers and CSP hashes
cd frontend && npm run lint && npm run typecheck && npm test && npm run build
```

## Rules

- **The offline suite stays at 100%, and every mutation stays caught.** A new
  safety property needs both a task in `tasks.yaml` and a mutation that breaks
  it. Run the suite before saying a change is done.
- **Never execute real commands while developing or testing.** The offline
  harness intercepts every process spawn, keystroke, and model call; test the
  backend in-process with `TestClient` under `isolated_state()` and
  `offline_guards()`. `~/.imperium` holds the owner's real pairing token and
  audit log — never read or write it.
- `python3 evals/runner.py --live` drives the real Mac and needs an API key.
  Only run it when the owner asks.
- Model-written AppleScript goes through the policy gate; every value
  interpolated into a handler template goes through
  `policy_gate.applescript_literal`.
- The frontend must keep working under a strict CSP: no
  `dangerouslySetInnerHTML`, no inline scripts of its own, no `eval`, no
  third-party scripts, fonts, or CDNs, and same-origin requests only.
- Python targets 3.9 (CI uses 3.11). Node 22+.
- Never commit `backend/.env` or anything generated (`frontend/out`,
  `frontend/.next`, `node_modules`).

## Status

v2 (security layer) and the v3 backend and phone app are done and pushed; the
offline suite is at 173 checks with 47 mutations, and CI runs it with the
frontend lint, typecheck, tests, build, and export check on every push.

Open: the 11-task live eval suite has never run (needs `ANTHROPIC_API_KEY` in
`backend/.env`), frontend unit tests are thin (only the SSE parser is covered),
and Tailscale, a demo video, and screenshots are still to do. Never state live
eval numbers until `--live` has actually run.
