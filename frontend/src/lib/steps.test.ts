import { describe, expect, it } from "vitest";
import type { LoggedEvent } from "./eventLog";
import { describeEvent, eventsForCommand, findFinished, groupByCommand, outcomeOf, traceSteps, wasBlocked } from "./steps";
import type { CommandStreamEvent } from "./types";

const COMMAND_ID = "a1b2c3d4e5f6";

function logged(event: Partial<CommandStreamEvent> & { type: CommandStreamEvent["type"] }, seq = 1): LoggedEvent {
  return {
    seq,
    id: String(seq),
    bootId: "boot-one",
    receivedAt: 1000 + seq,
    event: { ts: seq, command_id: COMMAND_ID, client_id: "c-1", ...event } as CommandStreamEvent,
  };
}

function trace(...events: LoggedEvent[]): LoggedEvent[] {
  return events;
}

describe("describeEvent", () => {
  it("shows a script's length and marks a truncated preview", () => {
    const step = describeEvent(
      { type: "script", ts: 1, command_id: COMMAND_ID, client_id: null, preview: "tell app", length: 1200 },
      "k",
    );
    expect(step.detail).toBe("1,200 chars");
    expect(step.code).toBe("tell app\n…");

    const whole = describeEvent(
      { type: "script", ts: 1, command_id: COMMAND_ID, client_id: null, preview: "tell app", length: 8 },
      "k",
    );
    expect(whole.code).toBe("tell app");
  });

  it("reads a policy block and a repair in the server's own words", () => {
    expect(
      describeEvent({ type: "policy_blocked", ts: 1, command_id: COMMAND_ID, client_id: null, reason: "do shell script" }, "k"),
    ).toMatchObject({ title: "Blocked by policy", note: "do shell script", tone: "blocked" });
    expect(
      describeEvent({ type: "repair", ts: 1, command_id: COMMAND_ID, client_id: null, attempt: 2, error: "syntax error" }, "k"),
    ).toMatchObject({ title: "Repair attempt 2", note: "syntax error" });
  });

  it("distinguishes a finished command from a failed one", () => {
    const base = {
      ts: 1,
      command_id: COMMAND_ID,
      client_id: null,
      duration_ms: 1500,
      input_tokens: 900,
      output_tokens: 40,
      repair_attempts: 0,
      repair_succeeded: null,
      audit_id: 1,
      action: null,
    } as const;
    expect(describeEvent({ type: "finished", ...base, ok: true, error: null }, "k")).toMatchObject({
      title: "Finished",
      tone: "ok",
      note: null,
    });
    expect(describeEvent({ type: "finished", ...base, ok: false, error: "Notes is not running" }, "k")).toMatchObject({
      title: "Failed",
      tone: "danger",
      note: "Notes is not running",
    });
  });

  it("gives every step in a trace a distinct key", () => {
    const steps = traceSteps(trace(logged({ type: "confirmed", pending_id: "p" }, 1), logged({ type: "cancelled", pending_id: "p" }, 2)));
    expect(steps.map((step) => step.key)).toEqual(["1", "2"]);
  });
});

describe("eventsForCommand", () => {
  const mine = logged({ type: "command", command: "open notes", category: "app_open", tier: "act" }, 1);
  const theirs = logged({ type: "started", command_id: "ffffffffffff", client_id: "other", category: "app_open", tier: "act" }, 2);

  it("matches by client_id before the server's command_id is known", () => {
    expect(eventsForCommand([mine, theirs], "c-1", null)).toEqual([mine]);
  });

  it("matches by command_id once it is known", () => {
    expect(eventsForCommand([mine, theirs], null, COMMAND_ID)).toEqual([mine]);
  });

  it("returns nothing when neither id identifies a command", () => {
    expect(eventsForCommand([mine, theirs], null, null)).toEqual([]);
    expect(eventsForCommand([mine, theirs], "c-unknown", null)).toEqual([]);
  });
});

describe("outcomeOf", () => {
  const started = logged({ type: "started", category: "app_open", tier: "act" }, 1);
  const finishedOk = logged(
    {
      type: "finished",
      ok: true,
      action: "Opened Notes",
      error: null,
      duration_ms: 10,
      input_tokens: 1,
      output_tokens: 1,
      repair_attempts: 0,
      repair_succeeded: null,
      audit_id: 1,
    },
    3,
  );
  const finishedBad = logged({ ...finishedOk.event, ok: false, error: "blocked" } as never, 3);
  const blocked = logged({ type: "policy_blocked", reason: "do shell script" }, 2);

  it("reads a finished command as executed", () => {
    expect(outcomeOf(trace(started, finishedOk))?.label).toBe("Executed");
  });

  it("separates a policy block from an ordinary failure", () => {
    expect(outcomeOf(trace(started, blocked, finishedBad))?.label).toBe("Blocked");
    expect(outcomeOf(trace(started, finishedBad))?.label).toBe("Failed");
    expect(wasBlocked(trace(started, blocked))).toBe(true);
  });

  it("reports the latest state while a command is still going", () => {
    const pending = logged({ type: "pending", pending_id: "p", category: "message_send", tier: "destructive", details: [], expires_at: 2 }, 1);
    expect(outcomeOf(trace(pending))?.label).toBe("Pending");
    expect(outcomeOf(trace(pending, logged({ type: "cancelled", pending_id: "p" }, 2)))?.label).toBe("Cancelled");
    expect(outcomeOf(trace(pending, logged({ type: "confirmed", pending_id: "p" }, 2), started))?.label).toBe("Running");
    expect(outcomeOf([])).toBeNull();
  });

  it("finds the last finished event, not the first", () => {
    expect(findFinished(trace(finishedBad, finishedOk))?.ok).toBe(true);
    expect(findFinished(trace(started))).toBeNull();
  });
});

describe("groupByCommand", () => {
  it("groups a trace per command, most recently active first", () => {
    const first = [
      logged({ type: "command", command: "open notes", category: "app_open", tier: "act" }, 1),
      logged({ type: "started", category: "app_open", tier: "act" }, 2),
    ];
    const second = [
      logged({ type: "command", command_id: "ffffffffffff", client_id: "c-2", command: "play music", category: "spotify", tier: "act" }, 3),
    ];
    const groups = groupByCommand([...first, ...second]);
    expect(groups.map((group) => group.commandId)).toEqual(["ffffffffffff", COMMAND_ID]);
    expect(groups[1]).toMatchObject({ command: "open notes", category: "app_open", tier: "act", clientId: "c-1" });
    expect(groups[1].events).toHaveLength(2);
  });

  it("keeps the first and last timestamps of a command whose events arrive out of order", () => {
    const group = groupByCommand([
      logged({ type: "started", ts: 30, category: "app_open", tier: "act" }, 1),
      logged({ type: "command", ts: 10, command: "open notes", category: "app_open", tier: "act" }, 2),
    ])[0];
    expect([group.firstTs, group.lastTs]).toEqual([10, 30]);
    expect(group.command).toBe("open notes");
  });
});
