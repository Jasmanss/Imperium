"""Append-only audit log — every command, policy decision, and script run.

Stored in SQLite at ~/.imperium/audit.db. Writes are best-effort: an audit
failure never blocks or breaks the action itself, but is printed so it is
not silent.

Every row written for a command carries its `command_id`, so a command's
parking, confirmation or cancellation, blocked scripts, and result can be read
back together (`GET /audit?command_id=…`).
"""

from __future__ import annotations

import math
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
    ("command_id", "TEXT"),
    ("action", "TEXT"),
]

# The row shape `GET /audit` returns, in order.
ROW_COLUMNS = (
    "id", "ts", "command", "category", "tier", "decision", "script", "error", "ok",
    "duration_ms", "input_tokens", "output_tokens", "api_calls", "models",
    "repair_attempts", "repair_succeeded", "command_id", "action",
)

_EXECUTED = "decision IN ('executed', 'failed')"


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


def _insert(
    decision: str,
    command: str = "",
    category: str = "",
    tier: str = "",
    script: str = "",
    error: str = "",
    ok: bool | None = None,
    duration_ms: int | None = None,
    trace: dict | None = None,
    command_id: str | None = None,
    action: str | None = None,
) -> int | None:
    """Write one row and return its id. Raises if the database cannot take it."""
    t = trace or {}
    conn = _connect()
    try:
        with conn:
            cursor = conn.execute(
                "INSERT INTO audit (ts, command, category, tier, decision, script, error, ok, "
                "duration_ms, input_tokens, output_tokens, api_calls, models, repair_attempts, "
                "repair_succeeded, command_id, action) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    time.time(),
                    command[:1000],
                    category,
                    tier,
                    decision,
                    script[:8000],
                    error[:500],
                    None if ok is None else int(ok),
                    duration_ms,
                    t.get("input_tokens"),
                    t.get("output_tokens"),
                    t.get("api_calls"),
                    ",".join(t.get("models", [])) or None,
                    t.get("repair_attempts"),
                    None if t.get("repair_succeeded") is None else int(bool(t.get("repair_succeeded"))),
                    command_id,
                    None if action is None else str(action)[:1000],
                ),
            )
            row_id = cursor.lastrowid
    finally:
        conn.close()
    return row_id


def log_event(decision: str, **fields) -> int | None:
    """Record one row (fields as `_insert` takes them); its id, or None if unwritten.

    Best-effort by contract, and deliberately not narrowed to `sqlite3.Error`: a
    full disk (OSError), a value sqlite3 cannot bind (UnicodeEncodeError), or any
    other failure must not take the command's response, its `finished` event, or
    the command itself down with it.
    """
    try:
        return _insert(decision, **fields)
    except Exception as e:
        print(f"audit: failed to record event ({type(e).__name__}: {e})")
        return None


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
            f"FROM audit WHERE {_EXECUTED}"
        ).fetchone()
        durations: list[int] = []
        category_durations: dict[str, list[int]] = {}
        for row in conn.execute(
            "SELECT category, duration_ms FROM audit "
            f"WHERE duration_ms IS NOT NULL AND {_EXECUTED} ORDER BY duration_ms"
        ):
            durations.append(row["duration_ms"])
            category_durations.setdefault(row["category"], []).append(row["duration_ms"])
        by_category = []
        for row in conn.execute(
            "SELECT category, COUNT(*) AS n, "
            "SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok_n, "
            "SUM(COALESCE(input_tokens, 0)) AS input_tokens, "
            "SUM(COALESCE(output_tokens, 0)) AS output_tokens "
            f"FROM audit WHERE {_EXECUTED} "
            "GROUP BY category ORDER BY n DESC, category"
        ):
            by_category.append(
                {
                    "category": row["category"],
                    "n": row["n"],
                    "ok_n": row["ok_n"],
                    "p95_latency_ms": _percentile(category_durations.get(row["category"], []), 0.95),
                    "input_tokens": row["input_tokens"],
                    "output_tokens": row["output_tokens"],
                }
            )
        decisions = {
            row["decision"]: row["n"]
            for row in conn.execute(
                "SELECT decision, COUNT(*) AS n FROM audit WHERE decision IN "
                "('script_blocked', 'pending_confirmation', 'confirmed', 'cancelled') "
                "GROUP BY decision"
            )
        }
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
            "scripts_blocked_by_policy": decisions.get("script_blocked", 0),
            "parked_for_confirmation": decisions.get("pending_confirmation", 0),
            "confirmed": decisions.get("confirmed", 0),
            "cancelled": decisions.get("cancelled", 0),
            "by_category": by_category,
        }
    except Exception as e:
        print(f"audit: failed to compute stats ({type(e).__name__}: {e})")
        # The shape of an empty log, so the phone never meets a missing field.
        return {
            "commands": 0,
            "success_rate": None,
            "p50_latency_ms": None,
            "p95_latency_ms": None,
            "input_tokens": 0,
            "output_tokens": 0,
            "repair_attempts": 0,
            "commands_saved_by_repair": 0,
            "scripts_blocked_by_policy": 0,
            "parked_for_confirmation": 0,
            "confirmed": 0,
            "cancelled": 0,
            "by_category": [],
        }


def _percentile(sorted_values: list[int], q: float) -> int | None:
    """Nearest-rank percentile over a pre-sorted list."""
    if not sorted_values:
        return None
    rank = max(1, math.ceil(q * len(sorted_values)))
    return sorted_values[rank - 1]


def _query(
    limit: int,
    before_id: int | None = None,
    decision: str | None = None,
    command_id: str | None = None,
) -> list[dict]:
    """Rows newest first, filtered with bound parameters only."""
    clauses: list[str] = []
    params: list = []
    if before_id is not None:
        clauses.append("id < ?")
        params.append(before_id)
    if decision:
        clauses.append("decision = ?")
        params.append(decision)
    if command_id:
        clauses.append("command_id = ?")
        params.append(command_id)
    where = f"WHERE {' AND '.join(clauses)} " if clauses else ""
    conn = _connect()
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        f"SELECT {', '.join(ROW_COLUMNS)} FROM audit {where}ORDER BY id DESC LIMIT ?",
        (*params, limit),
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def recent(limit: int = 50) -> list[dict]:
    try:
        return _query(limit)
    except Exception as e:
        print(f"audit: failed to read log ({type(e).__name__}: {e})")
        return []


def page(
    limit: int = 50,
    before_id: int | None = None,
    decision: str | None = None,
    command_id: str | None = None,
) -> dict:
    """One page of `GET /audit`; next_before_id is None when no older rows match."""
    try:
        rows = _query(limit + 1, before_id, decision, command_id)
    except Exception as e:
        print(f"audit: failed to read log ({type(e).__name__}: {e})")
        return {"entries": [], "next_before_id": None}
    entries = rows[:limit]
    more = len(rows) > limit
    return {"entries": entries, "next_before_id": entries[-1]["id"] if more and entries else None}
