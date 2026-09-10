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
- **Script policy gate** — LLM-generated AppleScript is never executed raw: shell escapes, credential access, file deletion, and non-allowlisted apps are blocked
- **Append-only audit log** of every command, decision, and result (`~/.imperium/audit.db`)

The full threat model is in [SECURITY.md](SECURITY.md).

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
