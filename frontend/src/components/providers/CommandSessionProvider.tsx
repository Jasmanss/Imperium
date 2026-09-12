"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { ApiError, describeError, EXPIRED_MESSAGE, isExecutedResponse, isParkedResponse } from "@/lib/api";
import { newClientId } from "@/lib/ids";
import type { CommandStreamEvent, ExecutedResponse, ParkedCommand } from "@/lib/types";
import { useAuth } from "./AuthProvider";
import { useEventStream } from "./EventStreamProvider";

export type EntryPhase =
  | "sending" // POST /text-command in flight
  | "parked" // waiting for Confirm or Cancel
  | "confirming" // POST /confirm in flight
  | "cancelling" // DELETE /pending in flight
  | "cancelled" // cancelled from this device
  | "resolved" // confirmed or cancelled from another device
  | "done" // the command ran; result holds the response
  | "rejected"; // not run: an error response or no answer

export interface CommandMetrics {
  input_tokens: number;
  output_tokens: number;
  repair_attempts: number;
  repair_succeeded: boolean | null;
}

export interface FeedEntry {
  key: string;
  command: string;
  clientId: string | null;
  commandId: string | null;
  /** Local time (ms) the command was sent, or estimated for restored confirmations. */
  submittedAt: number;
  phase: EntryPhase;
  parked: ParkedCommand | null;
  /** Local time (ms) the parked data and its server_time arrived. */
  parkedAt: number | null;
  /** Bumped after a retriable confirm or cancel failure, to re-arm the card. */
  attempt: number;
  result: ExecutedResponse | null;
  /** Token and repair figures read from the audit log when no finished event arrived. */
  metrics: CommandMetrics | null;
  error: string | null;
  /** The server said this confirmation can no longer be used. */
  closed: boolean;
  resolvedAs: "confirmed" | "cancelled" | null;
  /** Parked before this page loaded, and listed by GET /pending. */
  restored: boolean;
}

export type FeedAction =
  | { type: "submitted"; key: string; command: string; clientId: string; at: number }
  | { type: "parked"; key: string; parked: ParkedCommand; at: number }
  | { type: "executed"; key: string; result: ExecutedResponse }
  | { type: "rejected"; key: string; error: string }
  | { type: "confirming"; key: string }
  | { type: "cancelling"; key: string }
  | { type: "cancelled"; key: string }
  | { type: "actionFailed"; key: string; error: string; closed: boolean }
  | { type: "restored"; pending: ParkedCommand[]; serverTime: number; at: number }
  | { type: "resolvedElsewhere"; pendingId: string; as: "confirmed" | "cancelled" }
  | { type: "metrics"; commandId: string; metrics: CommandMetrics }
  | { type: "dismissed"; key: string };

function update(entries: FeedEntry[], key: string, change: (entry: FeedEntry) => FeedEntry): FeedEntry[] {
  return entries.map((entry) => (entry.key === key ? change(entry) : entry));
}

function newEntry(key: string, command: string, clientId: string | null, submittedAt: number): FeedEntry {
  return {
    key,
    command,
    clientId,
    commandId: null,
    submittedAt,
    phase: "sending",
    parked: null,
    parkedAt: null,
    attempt: 0,
    result: null,
    metrics: null,
    error: null,
    closed: false,
    resolvedAs: null,
    restored: false,
  };
}

export function feedReducer(entries: FeedEntry[], action: FeedAction): FeedEntry[] {
  switch (action.type) {
    case "submitted":
      return [...entries, newEntry(action.key, action.command, action.clientId, action.at)];
    case "parked": {
      // GET /pending may have raced this response and restored the same confirmation.
      const withoutCopies = entries.filter(
        (entry) => entry.key === action.key || entry.parked?.pending_id !== action.parked.pending_id,
      );
      return update(withoutCopies, action.key, (entry) => ({
        ...entry,
        phase: "parked",
        parked: action.parked,
        parkedAt: action.at,
        commandId: action.parked.command_id,
      }));
    }
    case "executed":
      return update(entries, action.key, (entry) => ({
        ...entry,
        phase: "done",
        result: action.result,
        commandId: action.result.command_id,
        error: null,
      }));
    case "rejected":
      return update(entries, action.key, (entry) => ({ ...entry, phase: "rejected", error: action.error }));
    case "confirming":
      return update(entries, action.key, (entry) => ({ ...entry, phase: "confirming", error: null }));
    case "cancelling":
      return update(entries, action.key, (entry) => ({ ...entry, phase: "cancelling", error: null }));
    case "cancelled":
      return update(entries, action.key, (entry) => ({ ...entry, phase: "cancelled", closed: true }));
    case "actionFailed":
      return update(entries, action.key, (entry) => ({
        ...entry,
        phase: "parked",
        error: action.error,
        closed: entry.closed || action.closed,
        attempt: entry.attempt + 1,
      }));
    case "restored": {
      const known = new Set<string>();
      for (const entry of entries) {
        if (entry.parked) known.add(entry.parked.pending_id);
        if (entry.commandId) known.add(entry.commandId);
        if (entry.clientId) known.add(entry.clientId);
      }
      const additions = action.pending
        .filter(
          (item) =>
            !known.has(item.pending_id) && !known.has(item.command_id) && !(item.client_id && known.has(item.client_id)),
        )
        .map((item): FeedEntry => {
          // The listing's server_time is current; the one stored with each item is from when it was parked.
          const parked: ParkedCommand = { ...item, server_time: action.serverTime };
          return {
            ...newEntry(`pending-${item.pending_id}`, item.command, item.client_id, action.at - Math.max(0, action.serverTime - item.created_at) * 1000),
            commandId: item.command_id,
            phase: "parked",
            parked,
            parkedAt: action.at,
            restored: true,
          };
        });
      if (additions.length === 0) return entries;
      return [...entries, ...additions].sort((a, b) => a.submittedAt - b.submittedAt);
    }
    case "resolvedElsewhere":
      return entries.map((entry) =>
        entry.phase === "parked" && !entry.closed && entry.parked?.pending_id === action.pendingId
          ? { ...entry, phase: "resolved", resolvedAs: action.as, closed: true }
          : entry,
      );
    case "metrics":
      return entries.map((entry) => (entry.commandId === action.commandId ? { ...entry, metrics: action.metrics } : entry));
    case "dismissed":
      return entries.filter((entry) => entry.key !== action.key);
  }
}

function belongsToFeed(entries: readonly FeedEntry[], event: CommandStreamEvent): boolean {
  return entries.some(
    (entry) =>
      entry.commandId === event.command_id ||
      (event.client_id !== null && entry.clientId === event.client_id) ||
      (event.type === "pending" && entry.parked?.pending_id === event.pending_id),
  );
}

interface CommandSessionValue {
  entries: FeedEntry[];
  /** A command or a confirmation is running; the command bar waits. */
  busy: boolean;
  /** client_ids of commands sent from this page load. */
  clientIds: ReadonlySet<string>;
  send: (command: string) => void;
  confirm: (key: string, pendingId: string) => void;
  cancel: (key: string, pendingId: string) => void;
  dismiss: (key: string) => void;
}

const CommandSessionContext = createContext<CommandSessionValue | null>(null);

// Tokens and repairs normally arrive in the finished event; wait this long for
// it before reading the audit row instead.
const METRICS_GRACE_MS = 1500;

/**
 * This page load's commands. Lives above the routes, so a command keeps
 * running, and its result is kept, while the user looks at another screen.
 */
export function CommandSessionProvider({ children }: { children: ReactNode }) {
  const { api } = useAuth();
  const { client, log } = useEventStream();
  const [entries, dispatch] = useReducer(feedReducer, []);
  const entriesRef = useRef(entries);
  const sending = useRef(false);
  const acting = useRef(new Set<string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    const pendingTimers = timers.current;
    return () => {
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
    };
  }, []);

  // Show confirmations that are still parked (after a reload, or sent from
  // another device), and follow confirmations resolved elsewhere.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        api.listPending({ signal: controller.signal }).then(
          (list) =>
            dispatch({
              type: "restored",
              pending: Array.isArray(list.pending) ? list.pending : [],
              serverTime: list.server_time,
              at: Date.now(),
            }),
          () => undefined,
        );
      }, 250);
    };
    refresh();
    const unsubscribe = client.subscribeEvents((event) => {
      if (event.type === "hello") {
        refresh();
      } else if (event.type === "pending") {
        if (!belongsToFeed(entriesRef.current, event)) refresh();
      } else if (event.type === "confirmed" || event.type === "cancelled") {
        dispatch({ type: "resolvedElsewhere", pendingId: event.pending_id, as: event.type });
      }
    });
    return () => {
      unsubscribe();
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [api, client]);

  const fillMetrics = useCallback(
    (commandId: string) => {
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        const seen = log
          .getSnapshot()
          .some((item) => item.event.type === "finished" && item.event.command_id === commandId);
        if (seen) return;
        api.audit({ command_id: commandId, limit: 20 }).then(
          (page) => {
            const row = page.entries.find((entry) => entry.decision === "executed" || entry.decision === "failed");
            if (!row) return;
            dispatch({
              type: "metrics",
              commandId,
              metrics: {
                input_tokens: row.input_tokens ?? 0,
                output_tokens: row.output_tokens ?? 0,
                repair_attempts: row.repair_attempts ?? 0,
                repair_succeeded: row.repair_succeeded === null ? null : row.repair_succeeded === 1,
              },
            });
          },
          () => undefined,
        );
      }, METRICS_GRACE_MS);
      timers.current.add(timer);
    },
    [api, log],
  );

  const send = useCallback(
    async (text: string) => {
      const command = text.trim();
      if (!command || sending.current) return;
      sending.current = true;
      const clientId = newClientId();
      dispatch({ type: "submitted", key: clientId, command, clientId, at: Date.now() });
      try {
        const response = await api.sendCommand(command, clientId);
        if (isParkedResponse(response)) {
          dispatch({ type: "parked", key: clientId, parked: response, at: Date.now() });
        } else if (isExecutedResponse(response)) {
          dispatch({ type: "executed", key: clientId, result: response });
          fillMetrics(response.command_id);
        } else {
          dispatch({ type: "rejected", key: clientId, error: response.error || "The Mac did not run this command." });
        }
      } catch (error) {
        dispatch({ type: "rejected", key: clientId, error: describeError(error) });
      } finally {
        sending.current = false;
      }
    },
    [api, fillMetrics],
  );

  const confirm = useCallback(
    async (key: string, pendingId: string) => {
      if (acting.current.has(pendingId)) return;
      acting.current.add(pendingId);
      dispatch({ type: "confirming", key });
      try {
        const response = await api.confirm(pendingId);
        if (isExecutedResponse(response)) {
          dispatch({ type: "executed", key, result: response });
          fillMetrics(response.command_id);
        } else {
          dispatch({ type: "actionFailed", key, error: response.error || EXPIRED_MESSAGE, closed: true });
        }
      } catch (error) {
        // Without an answer the confirmation may still be usable, so the card
        // re-arms; an HTTP error closes it. Confirmation ids are single use, so
        // a second attempt can never run the command twice.
        const unreachable = error instanceof ApiError && error.status === 0;
        dispatch({ type: "actionFailed", key, error: describeError(error), closed: !unreachable });
      } finally {
        acting.current.delete(pendingId);
      }
    },
    [api, fillMetrics],
  );

  const cancel = useCallback(
    async (key: string, pendingId: string) => {
      if (acting.current.has(pendingId)) return;
      acting.current.add(pendingId);
      dispatch({ type: "cancelling", key });
      try {
        await api.cancel(pendingId);
        dispatch({ type: "cancelled", key });
      } catch (error) {
        const gone = error instanceof ApiError && error.status === 404;
        dispatch({ type: "actionFailed", key, error: describeError(error), closed: gone });
      } finally {
        acting.current.delete(pendingId);
      }
    },
    [api],
  );

  const dismiss = useCallback((key: string) => dispatch({ type: "dismissed", key }), []);

  const value = useMemo<CommandSessionValue>(() => {
    const clientIds = new Set<string>();
    for (const entry of entries) {
      if (entry.clientId && !entry.restored) clientIds.add(entry.clientId);
    }
    return {
      entries,
      busy: entries.some((entry) => entry.phase === "sending" || entry.phase === "confirming"),
      clientIds,
      send: (command) => void send(command),
      confirm: (key, pendingId) => void confirm(key, pendingId),
      cancel: (key, pendingId) => void cancel(key, pendingId),
      dismiss,
    };
  }, [entries, send, confirm, cancel, dismiss]);

  return <CommandSessionContext.Provider value={value}>{children}</CommandSessionContext.Provider>;
}

export function useCommandSession(): CommandSessionValue {
  const value = useContext(CommandSessionContext);
  if (!value) throw new Error("useCommandSession must be used inside CommandSessionProvider");
  return value;
}
