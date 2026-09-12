import type { StreamEventMeta } from "./events";
import type { CommandStreamEvent, ServerEvent } from "./types";

export interface LoggedEvent {
  /** Local arrival order. */
  seq: number;
  id: string | null;
  bootId: string | null;
  /** Local time (ms) the event arrived. */
  receivedAt: number;
  event: CommandStreamEvent;
}

export const EVENT_LOG_LIMIT = 500;

const EMPTY: readonly LoggedEvent[] = [];

/**
 * The events this tab has received, oldest first, shared by every screen.
 * Replayed events (same boot and id) are ignored, and the oldest events are
 * dropped past the limit. Snapshots are immutable arrays, for useSyncExternalStore.
 */
export class EventLog {
  private items: readonly LoggedEvent[] = EMPTY;
  private readonly seen = new Set<string>();
  private seq = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly limit: number = EVENT_LOG_LIMIT) {}

  getSnapshot = (): readonly LoggedEvent[] => this.items;

  getServerSnapshot = (): readonly LoggedEvent[] => EMPTY;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  add(event: ServerEvent, meta: StreamEventMeta, receivedAt: number = Date.now()): LoggedEvent | null {
    if (event.type === "hello") return null;
    const key = meta.id === null ? null : dedupeKey(meta.bootId, meta.id);
    if (key !== null) {
      if (this.seen.has(key)) return null;
      this.seen.add(key);
    }

    const entry: LoggedEvent = { seq: ++this.seq, id: meta.id, bootId: meta.bootId, receivedAt, event };
    const overflow = Math.max(0, this.items.length + 1 - this.limit);
    for (const dropped of this.items.slice(0, overflow)) {
      if (dropped.id !== null) this.seen.delete(dedupeKey(dropped.bootId, dropped.id));
    }
    this.items = [...this.items.slice(overflow), entry];
    for (const listener of this.listeners) listener();
    return entry;
  }
}

function dedupeKey(bootId: string | null, id: string): string {
  return `${bootId ?? ""}:${id}`;
}
