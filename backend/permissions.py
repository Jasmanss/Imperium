"""Tiered permission model for agent actions.

Every command is classified into a category, each category maps to a risk
tier, and each tier has a policy:

    read        -> auto   (observing state: screenshots, reading files)
    act         -> auto   (reversible actions: open apps, play music, type)
    destructive -> confirm (outward-facing or hard to undo: send email/text,
                            git push, quit everything)

"confirm" actions are parked as a pending entry and only execute after the
user taps Confirm on the phone. Overrides live in ~/.imperium/permissions.json
(created with defaults on first run).
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

CONFIG_FILE = Path.home() / ".imperium" / "permissions.json"

PENDING_TTL_SECONDS = 120

DEFAULT_CONFIG: dict = {
    "tiers": {
        "read": "auto",
        "act": "auto",
        "destructive": "confirm",
    },
    "categories": {
        "applescript_general": "act",
        "spotify": "act",
        "create_project": "act",
        "git": "act",
        "git_push": "destructive",
        "email_send": "destructive",
        "message_send": "destructive",
        "close_all_apps": "destructive",
    },
    "app_allowlist": [
        "Google Chrome",
        "Safari",
        "Spotify",
        "Mail",
        "Messages",
        "Notes",
        "Finder",
        "System Events",
        "Calendar",
        "Contacts",
        "Preview",
        "TextEdit",
        "Visual Studio Code",
    ],
}

_config_cache: dict | None = None
_pending: dict[str, dict] = {}


def load_config() -> dict:
    """Load config, writing defaults on first run; defaults fill missing keys."""
    global _config_cache
    if _config_cache is not None:
        return _config_cache
    config = {k: (v.copy() if isinstance(v, (dict, list)) else v) for k, v in DEFAULT_CONFIG.items()}
    if CONFIG_FILE.exists():
        try:
            user = json.loads(CONFIG_FILE.read_text())
            for key, value in user.items():
                if isinstance(value, dict) and isinstance(config.get(key), dict):
                    config[key].update(value)
                else:
                    config[key] = value
        except (json.JSONDecodeError, OSError) as e:
            print(f"permissions: could not read {CONFIG_FILE} ({e}); using defaults")
    else:
        CONFIG_FILE.parent.mkdir(mode=0o700, exist_ok=True)
        CONFIG_FILE.write_text(json.dumps(DEFAULT_CONFIG, indent=2))
    _config_cache = config
    return config


def tier_for(category: str) -> str:
    return load_config()["categories"].get(category, "act")


def needs_confirmation(tier: str) -> bool:
    return load_config()["tiers"].get(tier, "confirm") == "confirm"


def app_allowlist() -> list[str]:
    return load_config()["app_allowlist"]


def create_pending(command: str, category: str) -> str:
    """Park a command awaiting user confirmation; returns its id."""
    _prune()
    pending_id = uuid.uuid4().hex[:12]
    _pending[pending_id] = {
        "command": command,
        "category": category,
        "created_at": time.time(),
    }
    return pending_id


def pop_pending(pending_id: str) -> dict | None:
    """Claim a pending command (single use); None if unknown or expired."""
    _prune()
    return _pending.pop(pending_id, None)


def _prune() -> None:
    cutoff = time.time() - PENDING_TTL_SECONDS
    for key in [k for k, v in _pending.items() if v["created_at"] < cutoff]:
        del _pending[key]
