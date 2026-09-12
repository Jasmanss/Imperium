"use client";

import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { EventLog, type LoggedEvent } from "@/lib/eventLog";
import { EventStreamClient, type StreamEventListener, type StreamState } from "@/lib/events";
import { readToken } from "@/lib/token";
import { useAuth } from "./AuthProvider";

interface EventStreamContextValue {
  client: EventStreamClient;
  log: EventLog;
}

const EventStreamContext = createContext<EventStreamContextValue | null>(null);

/** Owns the app's one connection to GET /events and the log every screen reads. */
export function EventStreamProvider({ children, client }: { children: ReactNode; client?: EventStreamClient }) {
  const { markUnauthorized } = useAuth();
  const [value] = useState<EventStreamContextValue>(() => ({
    client: client ?? new EventStreamClient({ getToken: readToken, onUnauthorized: markUnauthorized }),
    log: new EventLog(),
  }));

  useEffect(() => value.client.subscribeEvents((event, meta) => value.log.add(event, meta)), [value]);

  useEffect(() => value.client.retain(), [value]);

  return <EventStreamContext.Provider value={value}>{children}</EventStreamContext.Provider>;
}

export function useEventStream(): EventStreamContextValue {
  const value = useContext(EventStreamContext);
  if (!value) throw new Error("useEventStream must be used inside EventStreamProvider");
  return value;
}

export function useStreamState(): StreamState {
  const { client } = useEventStream();
  return useSyncExternalStore(client.subscribeState, client.getState, client.getState);
}

export function useEventLog(): readonly LoggedEvent[] {
  const { log } = useEventStream();
  return useSyncExternalStore(log.subscribe, log.getSnapshot, log.getServerSnapshot);
}

/** Call listener for every event, including hello, while the component is mounted. */
export function useStreamEvents(listener: StreamEventListener): void {
  const { client } = useEventStream();
  const onEvent = useEffectEvent(listener);
  useEffect(() => client.subscribeEvents((event, meta) => onEvent(event, meta)), [client]);
}

/**
 * A counter that goes up, at most once per delayMs, after events of the given
 * types arrive. Screens add it to a load key to refresh while the Mac works.
 */
export function useStreamSignal(types: readonly string[], delayMs: number): number {
  const { client } = useEventStream();
  const [signal, setSignal] = useState(0);
  const typeKey = types.join(",");

  useEffect(() => {
    const wanted = new Set(typeKey.split(","));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = client.subscribeEvents((event) => {
      if (!wanted.has(event.type) || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        setSignal((current) => current + 1);
      }, delayMs);
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [client, typeKey, delayMs]);

  return signal;
}
