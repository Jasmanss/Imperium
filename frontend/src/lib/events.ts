/**
 * The app's single connection to GET /events.
 *
 * EventSource cannot send an Authorization header, so the stream is read with
 * fetch and parsed incrementally. The client reconnects with capped exponential
 * backoff plus jitter, resumes with Last-Event-ID while the server's boot_id is
 * unchanged, and stops for good on 401. A missed heartbeat (the server sends a
 * comment at least every 15 seconds) counts as a dropped connection, which
 * catches half-open sockets after a phone sleeps.
 */

import { createSSEParser, type SSEMessage } from "./sse";
import type { CommandStreamEvent, CommandStreamEventType, HelloEvent, ServerEvent } from "./types";

export type StreamStatus = "idle" | "connecting" | "live" | "reconnecting" | "offline" | "busy" | "unauthorized";

export interface StreamState {
  status: StreamStatus;
  /** boot_id from the latest hello; changes when the backend restarts. */
  bootId: string | null;
  /** Local time (ms) the current connection said hello. */
  connectedAt: number | null;
  /** Consecutive failed connection attempts. */
  failures: number;
  /** Local time (ms) of the next scheduled attempt. */
  retryAt: number | null;
  /** Why the Mac refused the connection, in its own words, when it said so. */
  rejection: string | null;
}

export interface StreamEventMeta {
  /** The frame's id, or null for frames without one (hello). */
  id: string | null;
  bootId: string | null;
}

export type StreamEventListener = (event: ServerEvent, meta: StreamEventMeta) => void;

export interface EventStreamOptions {
  getToken: () => string | null;
  onUnauthorized?: () => void;
  url?: string;
  fetch?: typeof fetch;
  random?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  heartbeatTimeoutMs?: number;
  /** After this many consecutive failures the status reads "offline" rather than "reconnecting". */
  offlineAfterFailures?: number;
}

const COMMAND_EVENT_TYPES: ReadonlySet<string> = new Set<CommandStreamEventType>([
  "command",
  "pending",
  "confirmed",
  "cancelled",
  "started",
  "model_call",
  "script",
  "policy_blocked",
  "repair",
  "finished",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one frame's JSON data. Unknown or malformed events are dropped. */
export function parseServerEvent(data: string): ServerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.ts !== "number") return null;
  if (value.type === "hello") {
    return typeof value.boot_id === "string" ? (value as unknown as HelloEvent) : null;
  }
  if (!COMMAND_EVENT_TYPES.has(value.type) || typeof value.command_id !== "string") return null;
  const clientId = typeof value.client_id === "string" ? value.client_id : null;
  return { ...value, client_id: clientId } as unknown as CommandStreamEvent;
}

/** Equal-jitter exponential backoff: a delay between half and all of min(max, base * 2^(failures-1)). */
export function backoffDelay(
  failures: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

type Timer = ReturnType<typeof setTimeout>;

const INITIAL_STATE: StreamState = {
  status: "idle",
  bootId: null,
  connectedAt: null,
  failures: 0,
  retryAt: null,
  rejection: null,
};

/** Statuses the server explained itself, rather than the network failing. */
const REJECTED_STATUS: Partial<Record<number, StreamStatus>> = { 429: "busy" };

/** The `error` string from a JSON body, when the response carries one. */
async function refusalReason(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      const error = (body as Record<string, unknown>).error;
      if (typeof error === "string" && error.trim() !== "") return error.trim();
    }
  } catch {
    // Not JSON, or the body went away; the generic status still applies.
  }
  return null;
}

export class EventStreamClient {
  private readonly getToken: () => string | null;
  private readonly onUnauthorized: (() => void) | undefined;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly random: () => number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly offlineAfterFailures: number;

  private state: StreamState = INITIAL_STATE;
  private lastEventId: string | null = null;
  private lastActivityAt: number | null = null;
  private serverRetryMs: number | null = null;

  private running = false;
  private holders = 0;
  // Incremented whenever the current connection is abandoned, so callbacks
  // from an older connection can tell they are stale.
  private generation = 0;
  private controller: AbortController | null = null;
  private releaseTimer: Timer | null = null;
  private retryTimer: Timer | null = null;
  private watchdogTimer: Timer | null = null;

  private readonly stateListeners = new Set<() => void>();
  private readonly eventListeners = new Set<StreamEventListener>();

  constructor(options: EventStreamOptions) {
    this.getToken = options.getToken;
    this.onUnauthorized = options.onUnauthorized;
    this.url = options.url ?? "/events";
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.random = options.random ?? Math.random;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
    this.offlineAfterFailures = options.offlineAfterFailures ?? 3;
  }

  getState = (): StreamState => this.state;

  getLastEventId = (): string | null => this.lastEventId;

  subscribeState = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  };

  subscribeEvents = (listener: StreamEventListener): (() => void) => {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  };

  /**
   * Hold the connection open; the returned function releases the hold. The
   * connection closes shortly after the last hold is released. React strict
   * mode unmounts and immediately remounts effects in development, and the
   * deferred close lets the remount keep the same connection instead of
   * opening a second one.
   */
  retain(): () => void {
    this.holders += 1;
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders -= 1;
      if (this.holders > 0) return;
      this.releaseTimer = setTimeout(() => {
        this.releaseTimer = null;
        if (this.holders === 0) this.stop();
      }, 0);
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.handleOnline);
      document.addEventListener("visibilitychange", this.handleVisibility);
    }
    void this.connect();
  }

  stop(): void {
    this.detach();
    this.setState({ status: "idle", retryAt: null, rejection: null });
  }

  /** Drop the current attempt and connect again now. */
  reconnect(): void {
    if (!this.running) return;
    void this.connect();
  }

  private detach(): void {
    this.running = false;
    this.abandonConnection();
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.handleOnline);
      document.removeEventListener("visibilitychange", this.handleVisibility);
    }
  }

  private abandonConnection(): void {
    this.generation += 1;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.watchdogTimer !== null) clearTimeout(this.watchdogTimer);
    this.retryTimer = null;
    this.watchdogTimer = null;
    this.controller?.abort();
    this.controller = null;
  }

  private async connect(): Promise<void> {
    this.abandonConnection();
    const generation = this.generation;

    const token = this.getToken();
    if (!token) {
      this.handleUnauthorized();
      return;
    }

    const controller = new AbortController();
    this.controller = controller;
    const firstAttempt = this.state.connectedAt === null && this.state.failures === 0;
    this.setState({
      status: firstAttempt ? "connecting" : this.state.status === "offline" ? "offline" : "reconnecting",
      retryAt: null,
    });

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
    };
    // Resume only within the boot the id came from. If the backend restarted
    // meanwhile, the hello that follows carries a new boot_id and the stale id
    // is dropped before it could be sent again.
    if (this.state.bootId !== null && this.lastEventId !== null) {
      headers["Last-Event-ID"] = this.lastEventId;
    }

    this.armWatchdog(controller, generation);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, { headers, signal: controller.signal, cache: "no-store" });
    } catch {
      if (generation === this.generation) this.scheduleRetry();
      return;
    }

    if (generation !== this.generation) {
      discardBody(response);
      return;
    }
    if (response.status === 401) {
      discardBody(response);
      this.handleUnauthorized();
      return;
    }
    // A refusal the Mac explained — today that is 429, every event-stream slot
    // taken — is not the network being down, and its message says what to do
    // about it. Retrying is still right: the condition clears on its own.
    const rejected = REJECTED_STATUS[response.status];
    if (rejected !== undefined) {
      const reason = await refusalReason(response);
      if (generation !== this.generation) return;
      this.scheduleRetry(rejected, reason);
      return;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !response.body || !contentType.includes("text/event-stream")) {
      discardBody(response);
      this.scheduleRetry();
      return;
    }

    try {
      await this.consume(response.body, generation, controller);
    } catch {
      // A dropped connection, a missed heartbeat, or an abort; handled below.
    }
    if (generation === this.generation) this.scheduleRetry();
  }

  private async consume(
    body: ReadableStream<Uint8Array>,
    generation: number,
    controller: AbortController,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = createSSEParser({
      onMessage: (message) => this.handleMessage(message, generation),
      onRetry: (milliseconds) => {
        this.serverRetryMs = milliseconds;
      },
    });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || generation !== this.generation) break;
        this.lastActivityAt = Date.now();
        this.armWatchdog(controller, generation);
        parser.feed(decoder.decode(value, { stream: true }));
      }
      if (generation === this.generation) parser.feed(decoder.decode());
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  private handleMessage(message: SSEMessage, generation: number): void {
    if (generation !== this.generation) return;
    const event = parseServerEvent(message.data);
    if (!event) return;

    if (event.type === "hello") {
      if (this.state.bootId !== event.boot_id) this.lastEventId = null;
      this.setState({
        status: "live",
        bootId: event.boot_id,
        connectedAt: Date.now(),
        failures: 0,
        retryAt: null,
        rejection: null,
      });
      this.emit(event, { id: null, bootId: event.boot_id });
      return;
    }

    if (message.id !== null && message.id !== "") this.lastEventId = message.id;
    this.emit(event, { id: message.id || null, bootId: this.state.bootId });
  }

  private emit(event: ServerEvent, meta: StreamEventMeta): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event, meta);
      } catch (error) {
        // One failing listener must not take down the stream; rethrow outside
        // the read loop so the error is still reported.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  private scheduleRetry(rejected?: StreamStatus, rejection: string | null = null): void {
    if (!this.running) return;
    this.abandonConnection();
    const failures = this.state.failures + 1;
    const delay = backoffDelay(failures, this.serverRetryMs ?? this.baseDelayMs, this.maxDelayMs, this.random);
    const browserOffline = typeof navigator !== "undefined" && navigator.onLine === false;
    this.setState({
      status:
        rejected ?? (browserOffline || failures >= this.offlineAfterFailures ? "offline" : "reconnecting"),
      failures,
      retryAt: Date.now() + delay,
      rejection: rejected === undefined ? null : rejection,
    });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private handleUnauthorized(): void {
    this.detach();
    this.setState({ status: "unauthorized", retryAt: null, rejection: null });
    this.onUnauthorized?.();
  }

  private armWatchdog(controller: AbortController, generation: number): void {
    if (generation !== this.generation) return;
    if (this.watchdogTimer !== null) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      controller.abort();
    }, this.heartbeatTimeoutMs);
  }

  private readonly handleOnline = (): void => {
    if (this.running && this.state.status !== "live") this.reconnect();
  };

  private readonly handleVisibility = (): void => {
    if (!this.running || document.visibilityState !== "visible") return;
    const { status } = this.state;
    const silent =
      status === "live" &&
      this.lastActivityAt !== null &&
      Date.now() - this.lastActivityAt > this.heartbeatTimeoutMs;
    if (status === "reconnecting" || status === "offline" || silent) this.reconnect();
  };

  private setState(patch: Partial<StreamState>): void {
    const next = { ...this.state, ...patch };
    const changed = (Object.keys(next) as (keyof StreamState)[]).some((key) => next[key] !== this.state[key]);
    if (!changed) return;
    this.state = next;
    for (const listener of this.stateListeners) listener();
  }
}

function discardBody(response: Response): void {
  try {
    response.body?.cancel().catch(() => undefined);
  } catch {
    // The body was already locked or consumed.
  }
}
