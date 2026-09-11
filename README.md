# Imperium

A text-based AI agent that lets you control your Mac from your phone. Send natural language commands and watch your computer execute them in real-time.

**Demo:** https://youtu.be/jEpbP-iGQTk

## What is Imperium?

Imperium is a personal automation system that bridges your phone and your Mac. Instead of walking to your computer, just text it what you want — open apps, send emails, play music, search the web, or even create entire projects.

The system uses a FastAPI backend running on your Mac that interprets natural language commands and translates them into AppleScript or direct app integrations. A simple web frontend accessible from your phone acts as the remote control.

No need to remember complex commands or navigate through menus. Just say what you want in plain English:

- "Open YouTube and search for MrBeast"
- "Send an email to john@example.com about the meeting tomorrow"
- "Play Drake on Spotify"
- "Create a calculator app"
- "Commit changes in MyProject with message fixed the bug"

## Features

- **App Control** — Open, close, and switch between any Mac application
- **Web Navigation** — Open websites, search Google/YouTube, navigate to specific pages
- **Email Composition** — Compose and send emails with visual typing so you can watch it happen
- **Spotify Integration** — Play songs, control playback, search for music
- **iMessage** — Send texts to contacts by name or phone number
- **Git Operations** — Commit, push, pull, and check status of your repos
- **Project Generation** — Describe an app and watch it get created
- **Visual Typing** — See text being typed character-by-character for emails under 1000 characters
- **Live Navigation Bar** — See what app/page is currently active on your phone

## Setup

1. Clone the repo
2. Install dependencies: `pip install -r backend/requirements.txt`
3. Add your Anthropic API key to `backend/.env`
4. Run the server: `python backend/main.py`
5. **Pair your phone:** scan the QR code printed in the terminal (it opens
   `http://YOUR_MAC_IP:8000/app` with a one-time pairing link)

For access away from home Wi-Fi, run the server behind
[Tailscale](https://tailscale.com) and pair using the Tailscale IP — never
port-forward the server to the public internet.

## Security

An agent that executes real actions on your Mac is a remote-execution
surface, so v2 treats security as the core feature:

- **Pairing-token auth** on every action endpoint (QR-code pairing, deny-by-default middleware)
- **Tiered permissions** — destructive actions (send email/text, git push, quit everything) require a Confirm tap on your phone before anything runs
- **Script policy gate** — model-generated AppleScript is never executed raw: a gate that lexes scripts the way AppleScript does blocks shell escapes, credential access, file deletion, unconfirmed sends, and apps outside the allowlist, and built-in handlers quote every value taken from a command
- **Append-only audit log** of every command, decision, result, and executed script (`~/.imperium/audit.db`)

The full threat model is in [SECURITY.md](SECURITY.md).

## Evals

`evals/` holds the eval harness: [`tasks.yaml`](evals/tasks.yaml) defines the tasks, [`runner.py`](evals/runner.py) runs them, and [`RESULTS.md`](evals/RESULTS.md) is regenerated on every run.

- **Offline suite** — deterministic checks of auth, the permission gate and confirm flow, the script policy gate, AppleScript injection into built-in handlers, the AppleScript validator, the retry-with-repair loop, tracing, and the audit store. Needs no API key; process spawns, keystrokes, and model calls are intercepted (including while the backend is imported), so it never drives the Mac.
- **Mutation check** — deliberately breaks each safety property in turn and requires the offline suite to catch it.
- **Live suite** — real commands on a real Mac, verified by querying macOS state with AppleScript. Anything that would send, push, delete, or quit is refused even if listed.

```bash
pip install -r evals/requirements.txt
python3 evals/runner.py          # offline suite + mutation check
python3 evals/runner.py --live   # also run the live tasks (needs ANTHROPIC_API_KEY)
```

Every command also records latency, token usage, and repair attempts in the audit log; `GET /stats` returns success rate, p50/p95 latency, token totals, and how many commands the repair loop saved.

## Team

Originally built as a team hackathon project (March 2026) by:

- **Jasman Sidhu** ([@Jasmanss](https://github.com/Jasmanss)) — lead developer
- **Mark Gjonlleshaj** ([@MarkGjo](https://github.com/MarkGjo))
- **Meron M** ([@MeronM18](https://github.com/MeronM18))

This repository is the actively maintained home of the project; the full commit history from the hackathon is preserved.

### What I built (Jasman)

- The pivot from voice control to the text-command architecture
- Spotify control, Git integration, and contact-based iMessage sending
- Visual character-by-character typing (pyautogui) and the live navigation status bar
- Project generation, command parsing improvements, and documentation

## The Future

- **Automation Chains** — Workflows that execute multiple commands in sequence
- **Voice Control** — Speech-to-text so you can speak commands instead of typing
- **Multi-Device Support** — Control multiple Macs from a single interface
- **Screen Awareness** — Let the AI see your screen and make context-aware decisions
- **Calendar & Task Integration** — "Schedule a meeting with John tomorrow at 3pm"
- **Smart Home Bridge** — Control lights, thermostat, and devices through your Mac

---

Built with Claude, FastAPI, and AppleScript.
