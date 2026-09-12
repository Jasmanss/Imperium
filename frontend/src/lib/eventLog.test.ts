import { describe, expect, it, vi } from "vitest";
import { commandEvent } from "@/test/fixtures";
import { EventLog } from "./eventLog";
import type { StreamEventMeta } from "./events";

function meta(id: string | null, bootId: string | null = "boot-one"): StreamEventMeta {
  return { id, bootId };
}

describe("EventLog", () => {
  it("keeps events oldest first, numbered in arrival order", () => {
    const log = new EventLog();
    log.add(commandEvent({ command_id: "aaaaaaaaaaaa" }), meta("1"), 1000);
    log.add(commandEvent({ command_id: "bbbbbbbbbbbb" }), meta("2"), 2000);
    expect(log.getSnapshot().map((item) => [item.seq, item.event.command_id, item.receivedAt])).toEqual([
      [1, "aaaaaaaaaaaa", 1000],
      [2, "bbbbbbbbbbbb", 2000],
    ]);
  });

  it("never logs hello", () => {
    const log = new EventLog();
    expect(log.add({ type: "hello", ts: 1, boot_id: "boot-one", server_time: 1 }, meta(null))).toBeNull();
    expect(log.getSnapshot()).toHaveLength(0);
  });

  it("ignores a replayed event, so a reconnect does not duplicate the trace", () => {
    const log = new EventLog();
    log.add(commandEvent(), meta("7"));
    expect(log.add(commandEvent(), meta("7"))).toBeNull();
    expect(log.getSnapshot()).toHaveLength(1);
  });

  it("treats the same id from a different boot as a different event", () => {
    const log = new EventLog();
    log.add(commandEvent(), meta("7", "boot-one"));
    log.add(commandEvent(), meta("7", "boot-two"));
    expect(log.getSnapshot()).toHaveLength(2);
  });

  it("keeps events that carry no id, since nothing identifies them", () => {
    const log = new EventLog();
    log.add(commandEvent(), meta(null));
    log.add(commandEvent(), meta(null));
    expect(log.getSnapshot()).toHaveLength(2);
  });

  it("drops the oldest events past the limit, and forgets their ids", () => {
    const log = new EventLog(3);
    for (const id of ["1", "2", "3", "4"]) log.add(commandEvent({ ts: Number(id) }), meta(id));
    expect(log.getSnapshot().map((item) => item.id)).toEqual(["2", "3", "4"]);
    // Event 1 has been evicted, so it is no longer deduplicated against.
    expect(log.add(commandEvent(), meta("1"))).not.toBeNull();
    expect(log.getSnapshot().map((item) => item.id)).toEqual(["3", "4", "1"]);
  });

  it("hands out immutable snapshots and tells subscribers when they change", () => {
    const log = new EventLog();
    const listener = vi.fn();
    const unsubscribe = log.subscribe(listener);
    const before = log.getSnapshot();
    log.add(commandEvent(), meta("1"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(log.getSnapshot()).not.toBe(before);
    expect(before).toHaveLength(0);

    log.add(commandEvent(), meta("1"));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    log.add(commandEvent(), meta("2"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("renders nothing on the server, so the export's markup matches the first client render", () => {
    const log = new EventLog();
    log.add(commandEvent(), meta("1"));
    expect(log.getServerSnapshot()).toHaveLength(0);
  });
});
