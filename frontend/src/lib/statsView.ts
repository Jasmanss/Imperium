/**
 * The Stats screen's tiles and category rows, built from a normalized GET
 * /stats response (see normalizeStats), so every value here is null-safe.
 */

import { formatCount, formatDuration, formatPercent, formatTokens, successRate } from "./format";
import { categoryLabel, type Tone } from "./labels";
import type { Stats } from "./types";

/** Success-rate colour: green from 90%, amber from 70%, red below, neutral with no data. */
export function rateTone(rate: number | null): Tone {
  if (rate === null) return "neutral";
  if (rate >= 0.9) return "ok";
  if (rate >= 0.7) return "pending";
  return "danger";
}

export interface StatTile {
  key: string;
  label: string;
  value: string;
  detail: string | null;
  /** The decision or tier colour the tile counts, shown as a dot. */
  tone: Tone | null;
  /** Colour the value itself, for figures that are good or bad at a glance. */
  valueTone: Tone | null;
}

export interface StatGroup {
  key: string;
  title: string;
  tiles: StatTile[];
}

function tile(key: string, label: string, value: string, extra: Partial<StatTile> = {}): StatTile {
  return { key, label, value, detail: null, tone: null, valueTone: null, ...extra };
}

export function statGroups(stats: Stats): StatGroup[] {
  const commands = stats.commands === 1 ? "1 command" : `${formatCount(stats.commands)} commands`;
  return [
    {
      key: "execution",
      title: "Execution",
      tiles: [
        tile("commands", "Commands", formatCount(stats.commands), { detail: "Executed or failed" }),
        tile("success_rate", "Success rate", formatPercent(stats.success_rate), {
          detail: stats.commands > 0 ? `Of ${commands}` : "No commands yet",
          valueTone: stats.success_rate === null ? null : rateTone(stats.success_rate),
        }),
        tile("p50_latency_ms", "Latency p50", formatDuration(stats.p50_latency_ms), { detail: "Median" }),
        tile("p95_latency_ms", "Latency p95", formatDuration(stats.p95_latency_ms), { detail: "95th percentile" }),
      ],
    },
    {
      key: "tokens",
      title: "Tokens",
      tiles: [
        tile("input_tokens", "Input", formatTokens(stats.input_tokens), {
          detail: `${formatCount(stats.input_tokens)} tokens`,
        }),
        tile("output_tokens", "Output", formatTokens(stats.output_tokens), {
          detail: `${formatCount(stats.output_tokens)} tokens`,
        }),
      ],
    },
    {
      key: "repair",
      title: "Repair",
      tiles: [
        tile("repair_attempts", "Attempts", formatCount(stats.repair_attempts), { detail: "Scripts sent back to fix" }),
        tile("commands_saved_by_repair", "Commands saved", formatCount(stats.commands_saved_by_repair), {
          detail: "Succeeded after a repair",
          valueTone: stats.commands_saved_by_repair > 0 ? "ok" : null,
        }),
      ],
    },
    {
      key: "safety",
      title: "Safety",
      tiles: [
        tile("scripts_blocked_by_policy", "Blocked by policy", formatCount(stats.scripts_blocked_by_policy), {
          detail: "Scripts refused before running",
          tone: "blocked",
        }),
        tile("parked_for_confirmation", "Parked", formatCount(stats.parked_for_confirmation), {
          detail: "Waited for confirmation",
          tone: "pending",
        }),
        tile("confirmed", "Confirmed", formatCount(stats.confirmed), { detail: "Then allowed to run", tone: "act" }),
        tile("cancelled", "Cancelled", formatCount(stats.cancelled), { detail: "Never ran", tone: "muted" }),
      ],
    },
  ];
}

export interface CategoryRow {
  category: string;
  label: string;
  n: number;
  okN: number;
  rate: number | null;
  p95LatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
}

/** Per-category rows in the server's order (most commands first). */
export function categoryRows(stats: Stats): CategoryRow[] {
  return stats.by_category.map((row) => ({
    category: row.category,
    label: categoryLabel(row.category),
    n: row.n,
    okN: Math.min(row.ok_n, row.n),
    rate: successRate(row.ok_n, row.n),
    p95LatencyMs: row.p95_latency_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
  }));
}
