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

# Columns added after the first release. CREATE TABLE IF NOT EXISTS is a no-op on
# an existing table, so these must be applied with ALTER TABLE or a database
# created by an older version silently lacks them.
_ADDED_COLUMNS: list[tuple[str, str]] = [
    ("input_tokens", "INTEGER"),
    ("output_tokens", "INTEGER"),
    ("api_calls", "INTEGER"),
    ("models", "TEXT"),
    ("repair_attempts", "INTEGER"),
    ("repair_succeeded", "INTEGER"),
]


def _migrate(conn: sqlite3.Connection) -> None:
    existing = {row[1] for row in conn.execute("PRAGMA table_info(audit)")}
    for name, decl in _ADDED_COLUMNS:
        if name not in existing:
            conn.execute(f"ALTER TABLE audit ADD COLUMN {name} {decl}")


def _connect() -> sqlite3.Connection:
    DB_FILE.parent.mkdir(mode=0o700, exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    conn.execute(_SCHEMA)
    with conn:
        _migrate(conn)
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
    trace: dict | None = None,
) -> None:
    t = trace or {}
    try:
        conn = _connect()
        with conn:
            conn.execute(
                "INSERT INTO audit (ts, command, category, tier, decision, script, error, ok, "
                "duration_ms, input_tokens, output_tokens, api_calls, models, repair_attempts, "
                "repair_succeeded) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                    t.get("input_tokens"),
                    t.get("output_tokens"),
                    t.get("api_calls"),
                    ",".join(t.get("models", [])) or None,
                    t.get("repair_attempts"),
                    None if t.get("repair_succeeded") is None else int(bool(t.get("repair_succeeded"))),
                ),
            )
        conn.close()
    except sqlite3.Error as e:
        print(f"audit: failed to record event ({e})")


def stats() -> dict:
    """Aggregate execution stats for the /stats endpoint."""
    try:
        conn = _connect()
        conn.row_factory = sqlite3.Row
        totals = conn.execute(
            "SELECT COUNT(*) AS n, "
            "SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok_n, "
            "SUM(COALESCE(input_tokens, 0)) AS in_tok, "
            "SUM(COALESCE(output_tokens, 0)) AS out_tok, "
            "SUM(COALESCE(repair_attempts, 0)) AS repairs, "
            "SUM(CASE WHEN repair_succeeded = 1 THEN 1 ELSE 0 END) AS repairs_ok "
            "FROM audit WHERE decision IN ('executed', 'failed')"
        ).fetchone()
        durations = [
            row[0]
            for row in conn.execute(
                "SELECT duration_ms FROM audit "
                "WHERE duration_ms IS NOT NULL AND decision IN ('executed', 'failed') "
                "ORDER BY duration_ms"
            )
        ]
        by_category = [
            dict(row)
            for row in conn.execute(
                "SELECT category, COUNT(*) AS n, "
                "SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok_n "
                "FROM audit WHERE decision IN ('executed', 'failed') "
                "GROUP BY category ORDER BY n DESC"
            )
        ]
        blocked = conn.execute(
            "SELECT COUNT(*) FROM audit WHERE decision = 'script_blocked'"
        ).fetchone()[0]
        pending = conn.execute(
            "SELECT COUNT(*) FROM audit WHERE decision = 'pending_confirmation'"
        ).fetchone()[0]
        conn.close()

        n = totals["n"] or 0
        return {
            "commands": n,
            "success_rate": round((totals["ok_n"] or 0) / n, 3) if n else None,
            "p50_latency_ms": _percentile(durations, 0.50),
            "p95_latency_ms": _percentile(durations, 0.95),
            "input_tokens": totals["in_tok"] or 0,
            "output_tokens": totals["out_tok"] or 0,
            "repair_attempts": totals["repairs"] or 0,
            "commands_saved_by_repair": totals["repairs_ok"] or 0,
            "scripts_blocked_by_policy": blocked,
            "awaiting_confirmation": pending,
            "by_category": by_category,
        }
    except sqlite3.Error as e:
        print(f"audit: failed to compute stats ({e})")
        return {}


def _percentile(sorted_values: list[int], q: float) -> int | None:
    """Nearest-rank percentile over a pre-sorted list."""
    if not sorted_values:
        return None
    idx = max(0, min(len(sorted_values) - 1, int(round(q * (len(sorted_values) - 1)))))
    return sorted_values[idx]


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
