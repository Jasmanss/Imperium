"""Append-only audit log — every command, policy decision, and script run.

Stored in SQLite at ~/.imperium/audit.db. Writes are best-effort: an audit
failure never blocks or breaks the action itself, but is printed so it is
not silent.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

DB_FILE = Path.home() / ".imperium" / "audit.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    command TEXT,
    category TEXT,
    tier TEXT,
    decision TEXT NOT NULL,
    script TEXT,
    error TEXT,
    ok INTEGER,
    duration_ms INTEGER
);
"""


def _connect() -> sqlite3.Connection:
    DB_FILE.parent.mkdir(mode=0o700, exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    conn.execute(_SCHEMA)
    return conn


def log_event(
    decision: str,
    command: str = "",
    category: str = "",
    tier: str = "",
    script: str = "",
    error: str = "",
    ok: bool | None = None,
    duration_ms: int | None = None,
) -> None:
    try:
        conn = _connect()
        with conn:
            conn.execute(
                "INSERT INTO audit (ts, command, category, tier, decision, script, error, ok, duration_ms) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    time.time(),
                    command[:1000],
                    category,
                    tier,
                    decision,
                    script[:2000],
                    error[:500],
                    None if ok is None else int(ok),
                    duration_ms,
                ),
            )
        conn.close()
    except sqlite3.Error as e:
        print(f"audit: failed to record event ({e})")


def recent(limit: int = 50) -> list[dict]:
    try:
        conn = _connect()
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        conn.close()
        return [dict(row) for row in rows]
    except sqlite3.Error as e:
        print(f"audit: failed to read log ({e})")
        return []
