import type { CategoryStats, Stats } from "./types";

/** Shown wherever a value does not exist yet (no commands, no latency samples). */
export const EMPTY_VALUE = "—";

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimZeros(fixed: string): string {
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

export function formatDuration(ms: number | null | undefined): string {
  if (!isNumber(ms) || ms < 0) return EMPTY_VALUE;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const hundredths = Math.round(ms / 10) / 100;
  if (hundredths < 10) return `${hundredths.toFixed(2)} s`;
  const tenths = Math.round(ms / 100) / 10;
  if (tenths < 60) return `${tenths.toFixed(1)} s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
}

export function formatCount(value: number | null | undefined): string {
  return isNumber(value) ? Math.round(value).toLocaleString("en-US") : EMPTY_VALUE;
}

/** Token counts: 842, 12.4k, 1.25M. */
export function formatTokens(value: number | null | undefined): string {
  if (!isNumber(value)) return EMPTY_VALUE;
  const rounded = Math.round(value);
  if (Math.abs(rounded) < 1000) return String(rounded);
  if (Math.abs(rounded) < 999_950) return `${trimZeros((rounded / 1000).toFixed(1))}k`;
  return `${trimZeros((rounded / 1_000_000).toFixed(2))}M`;
}

/** A 0..1 rate as a percentage with at most one decimal: 87.5%, 100%. */
export function formatPercent(rate: number | null | undefined): string {
  if (!isNumber(rate)) return EMPTY_VALUE;
  const percent = Math.round(Math.min(1, Math.max(0, rate)) * 1000) / 10;
  return `${trimZeros(percent.toFixed(1))}%`;
}

export function successRate(okCount: number, total: number): number | null {
  return total > 0 ? Math.min(1, Math.max(0, okCount / total)) : null;
}

/** Local wall-clock time of an epoch-seconds timestamp, 24-hour: 14:03:22. */
export function formatClock(ts: number): string {
  if (!isNumber(ts)) return EMPTY_VALUE;
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

/** Local date and time of an epoch-seconds timestamp: Sep 10, 14:03:22. */
export function formatDateTime(ts: number): string {
  if (!isNumber(ts)) return EMPTY_VALUE;
  return new Date(ts * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

/** Seconds between two server timestamps, for trace offsets: +1.42 s. */
export function formatOffset(fromTs: number, toTs: number): string {
  if (!isNumber(fromTs) || !isNumber(toTs)) return EMPTY_VALUE;
  return `+${formatDuration(Math.max(0, (toTs - fromTs) * 1000))}`;
}

function count(value: unknown): number {
  return isNumber(value) && value > 0 ? value : 0;
}

function nullable(value: unknown): number | null {
  return isNumber(value) ? value : null;
}

/**
 * GET /stats with every field present. The server always answers the full
 * shape, zeroed when it cannot read its audit database, but a value that
 * arrives malformed must never take a screen down, and a fresh install has
 * null rates and latencies.
 */
export function normalizeStats(raw: unknown): Stats {
  const source = isRecord(raw) ? raw : {};
  const categories = Array.isArray(source.by_category) ? source.by_category : [];
  return {
    commands: count(source.commands),
    success_rate: nullable(source.success_rate),
    p50_latency_ms: nullable(source.p50_latency_ms),
    p95_latency_ms: nullable(source.p95_latency_ms),
    input_tokens: count(source.input_tokens),
    output_tokens: count(source.output_tokens),
    repair_attempts: count(source.repair_attempts),
    commands_saved_by_repair: count(source.commands_saved_by_repair),
    scripts_blocked_by_policy: count(source.scripts_blocked_by_policy),
    parked_for_confirmation: count(source.parked_for_confirmation),
    confirmed: count(source.confirmed),
    cancelled: count(source.cancelled),
    by_category: categories.filter(isRecord).map(
      (row): CategoryStats => ({
        category: typeof row.category === "string" && row.category ? row.category : "uncategorized",
        n: count(row.n),
        ok_n: count(row.ok_n),
        p95_latency_ms: nullable(row.p95_latency_ms),
        input_tokens: count(row.input_tokens),
        output_tokens: count(row.output_tokens),
      }),
    ),
  };
}

/** True once anything at all has been recorded. */
export function hasActivity(stats: Stats): boolean {
  return (
    stats.commands > 0 ||
    stats.parked_for_confirmation > 0 ||
    stats.scripts_blocked_by_policy > 0 ||
    stats.cancelled > 0
  );
}
