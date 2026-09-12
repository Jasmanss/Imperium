import { DECISIONS, type Decision, type KnownTier } from "./types";

/**
 * Semantic tones. A colour means the same thing on every screen: tiers are
 * read (neutral), act (blue), destructive (red); decisions are executed (green),
 * failed (red), script_blocked (orange), pending (amber), confirmed (blue),
 * cancelled (gray).
 */
export type Tone = "neutral" | "act" | "danger" | "ok" | "blocked" | "pending" | "muted";

export interface Label {
  label: string;
  tone: Tone;
}

const DECISION_LABELS: Record<Decision, Label> = {
  executed: { label: "Executed", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  script_blocked: { label: "Blocked", tone: "blocked" },
  pending_confirmation: { label: "Pending", tone: "pending" },
  confirmed: { label: "Confirmed", tone: "act" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

const TIER_LABELS: Record<KnownTier, Label> = {
  read: { label: "Read", tone: "neutral" },
  act: { label: "Act", tone: "act" },
  destructive: { label: "Destructive", tone: "danger" },
};

function lookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

export function humanize(value: string): string {
  const text = value.replace(/_/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Unknown";
}

export function decisionLabel(decision: string | null | undefined): Label {
  const known = decision ? lookup(DECISION_LABELS, decision) : undefined;
  return known ?? { label: decision ? humanize(decision) : "Unknown", tone: "neutral" };
}

export function tierLabel(tier: string | null | undefined): Label {
  const known = tier ? lookup(TIER_LABELS, tier) : undefined;
  return known ?? { label: tier ? humanize(tier) : "Unknown", tone: "neutral" };
}

export function categoryLabel(category: string | null | undefined): string {
  const text = category ? category.replace(/_/g, " ").trim() : "";
  return text || "uncategorized";
}

export function parseDecision(value: string | null | undefined): Decision | null {
  return value && (DECISIONS as readonly string[]).includes(value) ? (value as Decision) : null;
}

export interface DecisionFilter {
  value: Decision | null;
  label: string;
}

export const DECISION_FILTERS: readonly DecisionFilter[] = [
  { value: null, label: "All" },
  { value: "executed", label: "Executed" },
  { value: "failed", label: "Failed" },
  { value: "script_blocked", label: "Blocked" },
  { value: "pending_confirmation", label: "Pending" },
  { value: "confirmed", label: "Confirmed" },
  { value: "cancelled", label: "Cancelled" },
];
