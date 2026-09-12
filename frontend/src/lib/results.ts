/**
 * What a command's result card shows, from the POST response or the finished
 * event, plus whatever the event stream or the audit log reported about it.
 */

import type { LoggedEvent } from "./eventLog";
import type { Tone } from "./labels";
import { findFinished, wasBlocked } from "./steps";
import type { ExecutedResponse, FinishedEvent } from "./types";

export interface ResultMetrics {
  input_tokens: number;
  output_tokens: number;
  repair_attempts: number;
  repair_succeeded: boolean | null;
}

export interface ResultView {
  ok: boolean;
  /** Failed because the policy gate refused the generated script. */
  blocked: boolean;
  title: string;
  tone: Tone;
  action: string | null;
  error: string | null;
  /** The script's output, when it printed any. */
  output: string | null;
  durationMs: number | null;
  /** Null until the finished event or the audit row has reported them. */
  metrics: ResultMetrics | null;
  auditId: number | null;
  commandId: string;
}

export const DEFAULT_FAILURE = "The command did not complete.";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function metricsFromFinished(event: FinishedEvent): ResultMetrics {
  return {
    input_tokens: count(event.input_tokens),
    output_tokens: count(event.output_tokens),
    repair_attempts: count(event.repair_attempts),
    repair_succeeded: typeof event.repair_succeeded === "boolean" ? event.repair_succeeded : null,
  };
}

function outcome(ok: boolean, blocked: boolean): Pick<ResultView, "title" | "tone"> {
  if (ok) return { title: "Done", tone: "ok" };
  return blocked ? { title: "Blocked by policy", tone: "blocked" } : { title: "Failed", tone: "danger" };
}

/** A command that ran and answered this device's POST /text-command or /confirm. */
export function resultFromResponse(
  response: ExecutedResponse,
  events: readonly LoggedEvent[],
  fallback: ResultMetrics | null,
): ResultView {
  const finished = findFinished(events);
  const blocked = !response.ok && wasBlocked(events);
  const error = text(response.error) ?? (response.osascript_ok === false ? text(response.osascript_error) : null);
  return {
    ok: response.ok,
    blocked,
    ...outcome(response.ok, blocked),
    action: text(response.action),
    error: response.ok ? null : (error ?? DEFAULT_FAILURE),
    output: text(response.result),
    durationMs: typeof response.duration_ms === "number" ? response.duration_ms : null,
    metrics: finished ? metricsFromFinished(finished) : fallback,
    auditId: typeof response.audit_id === "number" ? response.audit_id : null,
    commandId: response.command_id,
  };
}

/** A command that ran without answering this device, such as one confirmed on another device. */
export function resultFromFinished(event: FinishedEvent, events: readonly LoggedEvent[]): ResultView {
  const blocked = !event.ok && wasBlocked(events);
  return {
    ok: event.ok,
    blocked,
    ...outcome(event.ok, blocked),
    action: text(event.action),
    error: event.ok ? null : (text(event.error) ?? DEFAULT_FAILURE),
    output: null,
    durationMs: typeof event.duration_ms === "number" ? event.duration_ms : null,
    metrics: metricsFromFinished(event),
    auditId: typeof event.audit_id === "number" ? event.audit_id : null,
    commandId: event.command_id,
  };
}

/** The repair badge: null when no repair was attempted. */
export function repairLabel(metrics: ResultMetrics | null): { label: string; tone: Tone } | null {
  if (!metrics || metrics.repair_attempts <= 0) return null;
  const attempts = metrics.repair_attempts === 1 ? "1 repair" : `${metrics.repair_attempts} repairs`;
  if (metrics.repair_succeeded === true) return { label: `Repaired · ${attempts}`, tone: "ok" };
  if (metrics.repair_succeeded === false) return { label: `Repair failed · ${attempts}`, tone: "danger" };
  return { label: attempts, tone: "pending" };
}

export interface AnnouncedEntry {
  phase: string;
  command: string;
  error: string | null;
  closed: boolean;
  resolvedAs: "confirmed" | "cancelled" | null;
}

/** One sentence for screen readers when a command's state changes; "" when there is nothing to say. */
export function announcement(entry: AnnouncedEntry, view: ResultView | null): string {
  switch (entry.phase) {
    case "sending":
      return `Sending: ${entry.command}`;
    case "parked":
      if (entry.closed) return entry.error ? `Confirmation closed. ${entry.error}` : "Confirmation closed.";
      return entry.error ? `Needs confirmation. ${entry.error}` : `Needs confirmation: ${entry.command}`;
    case "confirming":
      return "Confirmed. Running.";
    case "cancelling":
      return "Cancelling.";
    case "cancelled":
      return "Cancelled. Nothing ran.";
    case "resolved":
      if (view) return view.ok ? `Done: ${view.action ?? entry.command}` : `${view.title}: ${view.error ?? ""}`.trim();
      return entry.resolvedAs === "cancelled" ? "Cancelled on another device." : "Confirmed on another device.";
    case "done":
      if (!view) return "";
      return view.ok ? `Done: ${view.action ?? entry.command}` : `${view.title}: ${view.error ?? DEFAULT_FAILURE}`;
    case "rejected":
      return `Not run: ${entry.error ?? DEFAULT_FAILURE}`;
    default:
      return "";
  }
}
