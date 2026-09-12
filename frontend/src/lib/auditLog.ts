/**
 * The Audit screen's URL state, paging, and search, kept free of React so it
 * can be tested directly.
 */

import { formatCount, formatDateTime } from "./format";
import { isCommandId } from "./ids";
import { decisionLabel, parseDecision } from "./labels";
import type { AuditPage, AuditRow, Decision } from "./types";

export const AUDIT_PAGE_SIZE = 50;

export interface AuditFilters {
  decision: Decision | null;
  commandId: string | null;
}

export interface AuditParams extends AuditFilters {
  /** The entry open in the detail view. */
  id: number | null;
}

const ID_PATTERN = /^[1-9][0-9]{0,14}$/;

/** Read /audit/?decision=…&command_id=…&id=… , ignoring anything malformed. */
export function readAuditParams(params: { get(name: string): string | null }): AuditParams {
  const rawId = params.get("id");
  const rawCommandId = params.get("command_id");
  return {
    decision: parseDecision(params.get("decision")),
    commandId: isCommandId(rawCommandId) ? rawCommandId : null,
    id: rawId !== null && ID_PATTERN.test(rawId) ? Number(rawId) : null,
  };
}

/** An app path (without the /app base path, which next/link adds) for the Audit screen. */
export function auditHref(params: Partial<AuditParams> = {}): string {
  const search = new URLSearchParams();
  if (params.decision) search.set("decision", params.decision);
  if (params.commandId) search.set("command_id", params.commandId);
  if (params.id !== undefined && params.id !== null) search.set("id", String(params.id));
  const query = search.toString();
  return query ? `/audit/?${query}` : "/audit/";
}

export interface AuditListState {
  /** Newest first, one row per id. */
  entries: AuditRow[];
  /** Pass as before_id to load older rows; null when every matching row is loaded. */
  next: number | null;
}

export const EMPTY_AUDIT_LIST: AuditListState = { entries: [], next: null };

function rowsOf(page: AuditPage): AuditRow[] {
  return Array.isArray(page.entries) ? page.entries.filter((row) => typeof row?.id === "number") : [];
}

function nextOf(page: AuditPage): number | null {
  return typeof page.next_before_id === "number" ? page.next_before_id : null;
}

function unionById(...lists: readonly AuditRow[][]): AuditRow[] {
  const byId = new Map<number, AuditRow>();
  for (const list of lists) {
    for (const row of list) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
  }
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

export function firstPage(page: AuditPage): AuditListState {
  return { entries: unionById(rowsOf(page)), next: nextOf(page) };
}

/** Add an older page loaded with before_id. */
export function appendPage(state: AuditListState, page: AuditPage): AuditListState {
  return { entries: unionById(state.entries, rowsOf(page)), next: nextOf(page) };
}

/**
 * Merge a freshly loaded first page into what is already loaded. Audit rows
 * never change once written, so rows are merged by id. When the fresh page
 * does not reach back to the newest loaded row, the rows between them were
 * never fetched, and the list restarts from the fresh page rather than hide
 * that gap.
 */
export function mergeLatest(state: AuditListState, page: AuditPage): AuditListState {
  const fresh = rowsOf(page);
  const next = nextOf(page);
  if (state.entries.length === 0 || fresh.length === 0 || next === null) return firstPage(page);
  const oldestFresh = Math.min(...fresh.map((row) => row.id));
  if (oldestFresh > state.entries[0].id) return firstPage(page);
  return { entries: unionById(fresh, state.entries), next: state.next };
}

function searchable(row: AuditRow): string {
  return [
    `#${row.id}`,
    row.command,
    row.category,
    row.tier,
    row.decision,
    decisionLabel(row.decision).label,
    row.action,
    row.error,
    row.script,
    row.models,
    row.command_id,
  ]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join("\n")
    .toLowerCase();
}

/** Every whitespace-separated term must appear somewhere in the row. */
export function matchesSearch(row: AuditRow, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = searchable(row);
  return terms.every((term) => haystack.includes(term));
}

export function searchRows(rows: readonly AuditRow[], query: string): AuditRow[] {
  return query.trim() ? rows.filter((row) => matchesSearch(row, query)) : [...rows];
}

/** A 1 | 0 | null flag from SQLite as text. */
export function flagText(value: 1 | 0 | null | undefined, yes = "Yes", no = "No"): string | null {
  if (value === 1) return yes;
  if (value === 0) return no;
  return null;
}

export interface AuditField {
  /** The column name, as the API and the database spell it. */
  key: keyof AuditRow;
  /** Display text, or null when the column is empty. */
  value: string | null;
  mono: boolean;
}

function amount(value: number | null, unit = ""): string | null {
  return value === null ? null : `${formatCount(value)}${unit}`;
}

/** Every column of an audit row, in API order, for the detail view. */
export function auditFields(row: AuditRow): AuditField[] {
  return [
    { key: "id", value: String(row.id), mono: true },
    { key: "ts", value: typeof row.ts === "number" ? `${formatDateTime(row.ts)} · ${row.ts}` : null, mono: true },
    { key: "command", value: row.command, mono: false },
    { key: "category", value: row.category, mono: true },
    { key: "tier", value: row.tier, mono: true },
    { key: "decision", value: row.decision, mono: true },
    { key: "script", value: row.script === null ? null : `${formatCount(row.script.length)} characters, shown above`, mono: false },
    { key: "error", value: row.error, mono: false },
    { key: "ok", value: flagText(row.ok, "1 · ok", "0 · not ok"), mono: true },
    { key: "duration_ms", value: amount(row.duration_ms, " ms"), mono: true },
    { key: "input_tokens", value: amount(row.input_tokens), mono: true },
    { key: "output_tokens", value: amount(row.output_tokens), mono: true },
    { key: "api_calls", value: amount(row.api_calls), mono: true },
    { key: "models", value: row.models, mono: true },
    { key: "repair_attempts", value: amount(row.repair_attempts), mono: true },
    { key: "repair_succeeded", value: flagText(row.repair_succeeded, "1 · yes", "0 · no"), mono: true },
    { key: "command_id", value: row.command_id, mono: true },
    { key: "action", value: row.action, mono: false },
  ];
}
