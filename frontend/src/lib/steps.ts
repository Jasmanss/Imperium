/**
 * Turn event-stream events into readable steps: the live progress under a
 * command, and the per-command traces on the Activity screen.
 */

import type { LoggedEvent } from "./eventLog";
import { formatDuration, formatTokens } from "./format";
import { categoryLabel, decisionLabel, tierLabel, type Label, type Tone } from "./labels";
import type { CommandStreamEvent, FinishedEvent } from "./types";

export interface TraceStep {
  key: string;
  type: CommandStreamEvent["type"];
  title: string;
  /** Short machine detail, shown in monospace. */
  detail: string | null;
  /** A sentence from the server (an error or a policy reason), shown as text. */
  note: string | null;
  /** A script preview, shown in a monospace block. */
  code: string | null;
  tone: Tone;
  ts: number;
}

function tokensDetail(input: number, output: number): string {
  return `${formatTokens(input)} in · ${formatTokens(output)} out`;
}

export function describeEvent(event: CommandStreamEvent, key: string): TraceStep {
  const base = { key, type: event.type, ts: event.ts, detail: null, note: null, code: null };
  switch (event.type) {
    case "command":
      return {
        ...base,
        title: "Classified",
        detail: `${categoryLabel(event.category)} · ${tierLabel(event.tier).label.toLowerCase()}`,
        tone: "neutral",
      };
    case "pending":
      return {
        ...base,
        title: "Waiting for confirmation",
        detail: event.details.map((row) => `${row.label}: ${row.value}`).join(" · ") || null,
        tone: "pending",
      };
    case "confirmed":
      return { ...base, title: "Confirmed", tone: "act" };
    case "cancelled":
      return { ...base, title: "Cancelled", note: "Nothing ran.", tone: "muted" };
    case "started":
      return {
        ...base,
        title: "Running",
        detail: `${categoryLabel(event.category)} · ${tierLabel(event.tier).label.toLowerCase()}`,
        tone: "neutral",
      };
    case "model_call":
      return {
        ...base,
        title: "Model call",
        detail: `${event.model || "model"} · ${tokensDetail(event.input_tokens, event.output_tokens)}`,
        tone: "neutral",
      };
    case "script": {
      const truncated = event.length > event.preview.length;
      return {
        ...base,
        title: "Script",
        detail: `${event.length.toLocaleString("en-US")} chars`,
        code: truncated ? `${event.preview}\n…` : event.preview,
        tone: "neutral",
      };
    }
    case "policy_blocked":
      return { ...base, title: "Blocked by policy", note: event.reason || null, tone: "blocked" };
    case "repair":
      return { ...base, title: `Repair attempt ${event.attempt}`, note: event.error || null, tone: "pending" };
    case "finished":
      return {
        ...base,
        title: event.ok ? "Finished" : "Failed",
        detail: `${formatDuration(event.duration_ms)} · ${tokensDetail(event.input_tokens, event.output_tokens)}`,
        note: event.ok ? null : event.error || null,
        tone: event.ok ? "ok" : "danger",
      };
  }
}

export function traceSteps(events: readonly LoggedEvent[]): TraceStep[] {
  return events.map((item) => describeEvent(item.event, String(item.seq)));
}

/**
 * The events for one command, matched by its client_id until the server's
 * command_id is known, then by command_id.
 */
export function eventsForCommand(
  log: readonly LoggedEvent[],
  clientId: string | null,
  commandId: string | null,
): LoggedEvent[] {
  let id = commandId;
  if (id === null && clientId !== null) {
    id = log.find((item) => item.event.client_id === clientId)?.event.command_id ?? null;
  }
  if (id === null && clientId === null) return [];
  return log.filter(
    (item) => (id !== null && item.event.command_id === id) || (clientId !== null && item.event.client_id === clientId),
  );
}

export function findFinished(events: readonly LoggedEvent[]): FinishedEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const { event } = events[index];
    if (event.type === "finished") return event;
  }
  return null;
}

export function wasBlocked(events: readonly LoggedEvent[]): boolean {
  return events.some((item) => item.event.type === "policy_blocked");
}

/** Where a command stands, from the events seen so far. */
export function outcomeOf(events: readonly LoggedEvent[]): Label | null {
  const finished = findFinished(events);
  if (finished) {
    if (finished.ok) return decisionLabel("executed");
    return wasBlocked(events) ? decisionLabel("script_blocked") : decisionLabel("failed");
  }
  let latest: Label | null = null;
  for (const { event } of events) {
    if (event.type === "pending") latest = decisionLabel("pending_confirmation");
    else if (event.type === "cancelled") latest = decisionLabel("cancelled");
    else if (event.type === "confirmed") latest = decisionLabel("confirmed");
    else if (event.type === "started" || event.type === "model_call" || event.type === "script" || event.type === "repair") {
      latest = { label: "Running", tone: "act" };
    }
  }
  return latest;
}

export interface CommandGroup {
  commandId: string;
  command: string | null;
  category: string | null;
  tier: string | null;
  clientId: string | null;
  /** Oldest first, so each group reads as a trace. */
  events: LoggedEvent[];
  lastSeq: number;
  firstTs: number;
  lastTs: number;
}

/** Group events by command_id, most recently active command first. */
export function groupByCommand(log: readonly LoggedEvent[]): CommandGroup[] {
  const groups = new Map<string, CommandGroup>();
  for (const item of log) {
    const { event } = item;
    let group = groups.get(event.command_id);
    if (!group) {
      group = {
        commandId: event.command_id,
        command: null,
        category: null,
        tier: null,
        clientId: null,
        events: [],
        lastSeq: item.seq,
        firstTs: event.ts,
        lastTs: event.ts,
      };
      groups.set(event.command_id, group);
    }
    group.events.push(item);
    group.lastSeq = item.seq;
    group.lastTs = Math.max(group.lastTs, event.ts);
    group.firstTs = Math.min(group.firstTs, event.ts);
    group.clientId = group.clientId ?? event.client_id;
    if (event.type === "command") group.command = event.command;
    if ("category" in event && group.category === null) group.category = event.category;
    if ("tier" in event && group.tier === null) group.tier = event.tier;
  }
  return [...groups.values()].sort((a, b) => b.lastSeq - a.lastSeq);
}
