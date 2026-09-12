import { describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/fixtures";
import { backoffDelay, EventStreamClient, parseServerEvent, type StreamState } from "./events";
import type { ServerEvent } from "./types";

const BOOT = "boot-one";

function frame(event: string, data: unknown, id?: string): string {
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function hello(bootId = BOOT): string {
  return frame("hello", { type: "hello", ts: 1, boot_id: bootId, server_time: 1 });
}

function finished(id: string, commandId = "a1b2c3d4e5f6"): string {
  return frame(
    "finished",
    {
      type: "finished",
      ts: 2,
      command_id: commandId,
      client_id: null,
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
    id,
  );
}

/** An event-stream Response whose body stays open until `push`/`close` is called. */
function stream(initial: string[] = []) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      for (const chunk of initial) c.enqueue(encoder.encode(chunk));
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    push: (chunk: string) => controller.enqueue(encoder.encode(chunk)),
    close: () => controller.close(),
    /** What a real fetch body does when the request is aborted. */
    failOnAbort: (signal: AbortSignal | null) => {
      signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
    },
  };
}

interface Harness {
  client: EventStreamClient;
  attempts: { headers: Record<string, string>; signal: AbortSignal | null }[];
  events: ServerEvent[];
  states: StreamState[];
  onUnauthorized: ReturnType<typeof vi.fn>;
}

/** A client whose every connection is answered by `answer(attemptIndex, signal)`. */
function harness(
  answer: (attempt: number, signal: AbortSignal | null) => Response | Promise<Response>,
  options: Partial<ConstructorParameters<typeof EventStreamClient>[0]> = {},
): Harness {
  const attempts: Harness["attempts"] = [];
  const onUnauthorized = vi.fn();
  const client = new EventStreamClient({
    getToken: () => "tok-123",
    onUnauthorized,
    random: () => 0,
    baseDelayMs: 1,
    maxDelayMs: 1,
    fetch: (async (_input, init) => {
      const index = attempts.length;
      const signal = init?.signal ?? null;
      attempts.push({ headers: ((init?.headers ?? {}) as Record<string, string>) ?? {}, signal });
      return answer(index, signal);
    }) as typeof fetch,
    ...options,
  });
  const events: ServerEvent[] = [];
  const states: StreamState[] = [];
  client.subscribeEvents((event) => events.push(event));
  client.subscribeState(() => states.push(client.getState()));
  return { client, attempts, events, states, onUnauthorized };
}

/** Wait until `predicate` holds, letting the client's own microtasks run. */
async function until(predicate: () => boolean, what: string, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("parseServerEvent", () => {
  it("accepts hello and the command events", () => {
    expect(parseServerEvent('{"type":"hello","ts":1,"boot_id":"b","server_time":1}')).toMatchObject({ type: "hello" });
    expect(parseServerEvent('{"type":"started","ts":1,"command_id":"a1b2c3d4e5f6","client_id":"c-1"}')).toMatchObject({
      type: "started",
      client_id: "c-1",
    });
  });

  it("drops anything malformed rather than letting it reach a screen", () => {
    for (const data of [
      "not json",
      "[]",
      "null",
      '{"ts":1}',
      '{"type":"started"}',
      '{"type":"unknown","ts":1,"command_id":"a1b2c3d4e5f6"}',
      '{"type":"started","ts":1}',
      '{"type":"hello","ts":1}',
    ]) {
      expect(parseServerEvent(data)).toBeNull();
    }
  });

  it("normalises a missing client_id to null", () => {
    expect(parseServerEvent('{"type":"started","ts":1,"command_id":"a1b2c3d4e5f6"}')).toMatchObject({
      client_id: null,
    });
  });
});

describe("backoffDelay", () => {
  it("grows with failures, is capped, and never goes below half the ceiling", () => {
    expect(backoffDelay(1, 1000, 30_000, () => 0)).toBe(500);
    expect(backoffDelay(1, 1000, 30_000, () => 1)).toBe(1000);
    expect(backoffDelay(3, 1000, 30_000, () => 0)).toBe(2000);
    expect(backoffDelay(99, 1000, 30_000, () => 1)).toBe(30_000);
    expect(backoffDelay(0, 1000, 30_000, () => 0)).toBe(500);
  });
});

describe("EventStreamClient", () => {
  it("connects, reports live on hello, and delivers events", async () => {
    const open = stream([hello(), finished("10")]);
    const h = harness(() => open.response);
    const release = h.client.retain();
    await until(() => h.events.length === 2, "hello and finished");
    expect(h.client.getState()).toMatchObject({ status: "live", bootId: BOOT, failures: 0 });
    expect(h.client.getLastEventId()).toBe("10");
    release();
  });

  it("sends no Last-Event-ID on a first connection", async () => {
    const open = stream([hello()]);
    const h = harness(() => open.response);
    const release = h.client.retain();
    await until(() => h.events.length === 1, "hello");
    expect(h.attempts[0].headers["Last-Event-ID"]).toBeUndefined();
    release();
  });

  it("resumes with Last-Event-ID after a drop inside the same boot", async () => {
    const first = stream([hello(), finished("10")]);
    const second = stream([hello()]);
    const h = harness((attempt) => (attempt === 0 ? first.response : second.response));
    const release = h.client.retain();
    await until(() => h.events.length === 2, "the first connection's events");
    first.close();
    await until(() => h.attempts.length === 2, "the reconnect");
    expect(h.attempts[1].headers["Last-Event-ID"]).toBe("10");
    release();
  });

  it("drops a stale id when the Mac restarted, so a new boot never resumes an old one", async () => {
    const first = stream([hello("boot-one"), finished("10")]);
    const second = stream([hello("boot-two")]);
    const third = stream([hello("boot-two")]);
    const h = harness((attempt) => [first.response, second.response, third.response][attempt]);
    const release = h.client.retain();
    await until(() => h.events.length === 2, "the first boot's events");
    first.close();
    await until(() => h.attempts.length === 2, "the second connection");
    // The second connection still offers the id it had; the new boot_id clears it.
    expect(h.attempts[1].headers["Last-Event-ID"]).toBe("10");
    await until(() => h.client.getState().bootId === "boot-two", "the new boot");
    expect(h.client.getLastEventId()).toBeNull();
    second.close();
    await until(() => h.attempts.length === 3, "the third connection");
    expect(h.attempts[2].headers["Last-Event-ID"]).toBeUndefined();
    release();
  });

  it("stops for good on 401, reporting it exactly once and never retrying", async () => {
    const h = harness(() => jsonResponse(401, { error: "Unauthorized — this device is not paired." }));
    const release = h.client.retain();
    await until(() => h.client.getState().status === "unauthorized", "the unauthorized state");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.attempts).toHaveLength(1);
    expect(h.onUnauthorized).toHaveBeenCalledTimes(1);
    release();
  });

  it("reports 429 as busy in the Mac's own words, and keeps retrying", async () => {
    const message = "Too many open event streams — close the app on another device or tab and retry.";
    const h = harness(() => jsonResponse(429, { error: message }));
    const release = h.client.retain();
    await until(() => h.attempts.length >= 3, "several refused attempts");
    const state = h.client.getState();
    expect(state.status).toBe("busy");
    expect(state.rejection).toBe(message);
    release();
  });

  it("falls back to offline after enough failures the Mac did not explain", async () => {
    const h = harness(() => {
      throw new TypeError("Failed to fetch");
    });
    const release = h.client.retain();
    await until(() => h.client.getState().status === "offline", "the offline state");
    expect(h.client.getState().rejection).toBeNull();
    expect(h.client.getState().failures).toBeGreaterThanOrEqual(3);
    release();
  });

  it("clears a refusal once a connection says hello", async () => {
    const open = stream([hello()]);
    const h = harness((attempt) => (attempt === 0 ? jsonResponse(429, { error: "Too many" }) : open.response));
    const release = h.client.retain();
    await until(() => h.client.getState().status === "live", "the live state");
    expect(h.client.getState().rejection).toBeNull();
    release();
  });

  it("aborts a stream that goes silent past the heartbeat timeout", async () => {
    const open = stream([hello()]);
    const second = stream([hello()]);
    const h = harness(
      (attempt, signal) => {
        const connection = attempt === 0 ? open : second;
        connection.failOnAbort(signal);
        return connection.response;
      },
      { heartbeatTimeoutMs: 10 },
    );
    const release = h.client.retain();
    await until(() => h.client.getState().status === "live", "the live state");
    await until(() => h.attempts.length === 2, "the reconnect after the missed heartbeat");
    expect(h.attempts[0].signal?.aborted).toBe(true);
    release();
  });

  it("keeps one connection across a strict-mode remount, and aborts it on the last release", async () => {
    const open = stream([hello()]);
    const h = harness(() => open.response);
    const first = h.client.retain();
    const second = h.client.retain();
    await until(() => h.client.getState().status === "live", "the live state");
    first();
    second();
    await until(() => h.attempts[0].signal?.aborted === true, "the connection to be aborted");
    expect(h.attempts).toHaveLength(1);
    expect(h.client.getState().status).toBe("idle");
  });

  it("treats a missing token as a pairing problem, not a network one", async () => {
    const onUnauthorized = vi.fn();
    const client = new EventStreamClient({
      getToken: () => null,
      onUnauthorized,
      fetch: (() => {
        throw new Error("fetch must not be called without a token");
      }) as typeof fetch,
    });
    const release = client.retain();
    await until(() => client.getState().status === "unauthorized", "the unauthorized state");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    release();
  });

  it("ignores a response that is not an event stream and retries", async () => {
    const open = stream([hello()]);
    const h = harness((attempt) => (attempt === 0 ? jsonResponse(200, { status: "ok" }) : open.response));
    const release = h.client.retain();
    await until(() => h.client.getState().status === "live", "the live state");
    expect(h.attempts.length).toBeGreaterThanOrEqual(2);
    release();
  });
});
