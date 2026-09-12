import { describe, expect, it } from "vitest";
import { executed, parked } from "@/test/fixtures";
import { feedReducer, GONE_MESSAGE, type FeedAction, type FeedEntry } from "./CommandSessionProvider";

const SENT_AT = 1_800_000_000_000;

/** One command sent from this device and parked by the Mac. */
function parkedFeed(overrides = {}): { entries: FeedEntry[]; pendingId: string } {
  const item = parked(overrides);
  const sent = feedReducer([], { type: "submitted", key: "c-1", command: item.command, clientId: "c-1", at: SENT_AT });
  return {
    entries: feedReducer(sent, { type: "parked", key: "c-1", parked: item, at: SENT_AT + 50 }),
    pendingId: item.pending_id,
  };
}

describe("feedReducer", () => {
  it("parks a sent command and keeps the Mac's command_id", () => {
    const { entries } = parkedFeed();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ phase: "parked", commandId: "a1b2c3d4e5f6", closed: false, restored: false });
  });

  it("drops a restored copy of a confirmation this device just parked", () => {
    const item = parked();
    const restored = feedReducer([], {
      type: "restored",
      pending: [item],
      serverTime: item.created_at + 1,
      at: SENT_AT,
    });
    expect(restored).toHaveLength(1);
    const sent = feedReducer(restored, { type: "submitted", key: "c-1", command: item.command, clientId: "c-1", at: SENT_AT });
    const parkedAgain = feedReducer(sent, { type: "parked", key: "c-1", parked: item, at: SENT_AT + 50 });
    expect(parkedAgain.filter((entry) => entry.parked?.pending_id === item.pending_id)).toHaveLength(1);
  });

  it("restores a confirmation parked on another device, oldest first", () => {
    const { entries } = parkedFeed();
    const other = parked({ pending_id: "pend-2", command_id: "bbbbbbbbbbbb", client_id: "other", created_at: 1_699_999_900 });
    const merged = feedReducer(entries, { type: "restored", pending: [other], serverTime: 1_700_000_010, at: SENT_AT + 100 });
    expect(merged.map((entry) => entry.parked?.pending_id)).toEqual(["pend-2", "pend-1"]);
    expect(merged[0]).toMatchObject({ restored: true, phase: "parked" });
    // The listing's clock replaces the one stored when the entry was parked.
    expect(merged[0].parked?.server_time).toBe(1_700_000_010);
  });

  it("closes a card the authoritative listing no longer mentions", () => {
    // The confirmed/cancelled event was missed: the Mac restarted, so nothing replayed.
    const { entries } = parkedFeed();
    const settled = feedReducer(entries, {
      type: "restored",
      pending: [],
      serverTime: entries[0].parked!.created_at + 5,
      at: SENT_AT + 100,
    });
    expect(settled[0]).toMatchObject({ phase: "parked", closed: true, error: GONE_MESSAGE });
  });

  it("leaves a confirmation parked after the listing was taken alone", () => {
    // The listing raced an in-flight POST /text-command: its snapshot predates the entry.
    const { entries } = parkedFeed();
    const settled = feedReducer(entries, {
      type: "restored",
      pending: [],
      serverTime: entries[0].parked!.created_at - 1,
      at: SENT_AT + 100,
    });
    expect(settled).toBe(entries);
    expect(settled[0]).toMatchObject({ closed: false, error: null });
  });

  it("keeps a more specific error when the listing later confirms the card is gone", () => {
    const { entries, pendingId } = parkedFeed();
    const failed = feedReducer(entries, {
      type: "actionFailed",
      key: "c-1",
      error: "Confirmation expired or already used.",
      closed: false,
    });
    const settled = feedReducer(failed, {
      type: "restored",
      pending: [],
      serverTime: entries[0].parked!.created_at + 5,
      at: SENT_AT + 100,
    });
    expect(settled[0].error).toBe("Confirmation expired or already used.");
    expect(settled[0].closed).toBe(true);
    expect(settled[0].parked?.pending_id).toBe(pendingId);
  });

  it("does not touch a card already resolved, cancelled, or in flight", () => {
    const { entries } = parkedFeed();
    const listing: FeedAction = {
      type: "restored",
      pending: [],
      serverTime: entries[0].parked!.created_at + 5,
      at: SENT_AT + 100,
    };
    for (const action of [
      { type: "cancelled", key: "c-1" } as const,
      { type: "confirming", key: "c-1" } as const,
      { type: "cancelling", key: "c-1" } as const,
    ]) {
      const before = feedReducer(entries, action);
      const after = feedReducer(before, listing);
      expect(after[0].phase).toBe(before[0].phase);
      expect(after[0].error).toBeNull();
    }
  });

  it("follows a confirmation resolved on another device", () => {
    const { entries, pendingId } = parkedFeed();
    const resolved = feedReducer(entries, { type: "resolvedElsewhere", pendingId, as: "confirmed" });
    expect(resolved[0]).toMatchObject({ phase: "resolved", resolvedAs: "confirmed", closed: true });
    // A second event for a card already closed changes nothing.
    expect(feedReducer(resolved, { type: "resolvedElsewhere", pendingId, as: "cancelled" })[0].resolvedAs).toBe("confirmed");
  });

  it("re-arms a card after a confirm that may not have reached the Mac", () => {
    const { entries } = parkedFeed();
    const failed = feedReducer(feedReducer(entries, { type: "confirming", key: "c-1" }), {
      type: "actionFailed",
      key: "c-1",
      error: "Could not reach the Mac.",
      closed: false,
    });
    expect(failed[0]).toMatchObject({ phase: "parked", closed: false, attempt: 1 });
  });

  it("records a command that ran, and fills in its metrics later", () => {
    const sent = feedReducer([], { type: "submitted", key: "c-1", command: "open notes", clientId: "c-1", at: SENT_AT });
    const done = feedReducer(sent, { type: "executed", key: "c-1", result: executed() });
    expect(done[0]).toMatchObject({ phase: "done", commandId: "a1b2c3d4e5f6", error: null });

    const metrics = { input_tokens: 900, output_tokens: 40, repair_attempts: 1, repair_succeeded: true };
    expect(feedReducer(done, { type: "metrics", commandId: "a1b2c3d4e5f6", metrics })[0].metrics).toEqual(metrics);
    expect(feedReducer(done, { type: "metrics", commandId: "ffffffffffff", metrics })[0].metrics).toBeNull();
  });

  it("dismisses one card without touching the others", () => {
    const { entries } = parkedFeed();
    const two = feedReducer(entries, { type: "submitted", key: "c-2", command: "open mail", clientId: "c-2", at: SENT_AT + 1 });
    expect(feedReducer(two, { type: "dismissed", key: "c-1" }).map((entry) => entry.key)).toEqual(["c-2"]);
  });
});
