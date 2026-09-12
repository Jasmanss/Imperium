import { describe, expect, it, vi } from "vitest";
import { executed, jsonResponse, parked } from "@/test/fixtures";
import {
  ApiError,
  auditSearch,
  createApiClient,
  describeError,
  isAbortError,
  isExecutedResponse,
  isParkedResponse,
  NETWORK_ERROR_MESSAGE,
  UNAUTHORIZED_MESSAGE,
} from "./api";

function client(
  handler: (path: string, init: RequestInit) => Response | Promise<Response>,
  options: { token?: string | null; onUnauthorized?: () => void } = {},
) {
  const calls: { path: string; init: RequestInit }[] = [];
  const api = createApiClient({
    getToken: () => (options.token === undefined ? "tok-123" : options.token),
    onUnauthorized: options.onUnauthorized,
    fetch: (async (input, init) => {
      const path = String(input);
      calls.push({ path, init: (init ?? {}) as RequestInit });
      return handler(path, (init ?? {}) as RequestInit);
    }) as typeof fetch,
  });
  return { api, calls };
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

describe("auditSearch", () => {
  it("clamps the limit to what the backend accepts", () => {
    expect(auditSearch({ limit: 0 })).toBe("?limit=1");
    expect(auditSearch({ limit: 50 })).toBe("?limit=50");
    expect(auditSearch({ limit: 5000 })).toBe("?limit=200");
    expect(auditSearch({ limit: 12.9 })).toBe("?limit=12");
  });

  it("passes the filters through and omits an empty query", () => {
    expect(auditSearch({})).toBe("");
    expect(auditSearch({ before_id: 41.7, decision: "failed", command_id: "a1b2c3d4e5f6" })).toBe(
      "?before_id=41&decision=failed&command_id=a1b2c3d4e5f6",
    );
  });
});

describe("request", () => {
  it("sends the pairing token as a Bearer header, and never in the URL", async () => {
    const { api, calls } = client(() => jsonResponse(200, { pending: [], server_time: 1 }));
    await api.listPending();
    expect(calls[0].path).toBe("/pending");
    expect(headersOf(calls[0].init).Authorization).toBe("Bearer tok-123");
    expect(calls[0].init.cache).toBe("no-store");
  });

  it("leaves the health check unauthenticated", async () => {
    const { api, calls } = client(() => jsonResponse(200, { status: "Mac is ready for commands" }));
    await api.health();
    expect(headersOf(calls[0].init).Authorization).toBeUndefined();
  });

  it("turns a 401 into ApiError(401) and calls onUnauthorized once", async () => {
    const onUnauthorized = vi.fn();
    const { api } = client(() => jsonResponse(401, { error: "Unauthorized — not paired" }), { onUnauthorized });
    await expect(api.stats()).rejects.toMatchObject({ status: 401, message: UNAUTHORIZED_MESSAGE });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("turns an unreachable Mac into ApiError(0), keeping the browser's text out of the UI", async () => {
    const { api } = client(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(api.stats()).rejects.toMatchObject({ status: 0, message: NETWORK_ERROR_MESSAGE });
  });

  it("re-throws an abort instead of reporting the Mac as unreachable", async () => {
    const { api } = client(() => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(api.stats()).rejects.toSatisfy(isAbortError);
  });

  it("prefers the server's own message for a non-401 error", async () => {
    const { api } = client(() => jsonResponse(404, { error: "Confirmation expired or already used." }));
    await expect(api.cancel("pend-1")).rejects.toMatchObject({
      status: 404,
      message: "Confirmation expired or already used.",
    });
  });

  it("falls back to the status when the error body says nothing", async () => {
    const { api } = client(() => new Response("<html>502</html>", { status: 502 }));
    await expect(api.stats()).rejects.toMatchObject({ status: 502, message: "The Mac answered with HTTP 502." });
  });

  it("rejects a 200 that is not JSON rather than returning undefined", async () => {
    const { api } = client(() => new Response("", { status: 200 }));
    await expect(api.stats()).rejects.toBeInstanceOf(ApiError);
  });

  it("percent-encodes a pending id into the path", async () => {
    const { api, calls } = client(() => jsonResponse(200, { cancelled: true, pending_id: "a/b", command_id: "x" }));
    await api.cancel("a/b");
    expect(calls[0].path).toBe("/pending/a%2Fb");
  });

  it("omits client_id when the caller has none", async () => {
    const { api, calls } = client(() => jsonResponse(200, executed()));
    await api.sendCommand("open notes", null);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ command: "open notes" });
    await api.sendCommand("open notes", "c-9");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ command: "open notes", client_id: "c-9" });
  });
});

describe("response discrimination", () => {
  it("tells a parked command from one that ran and from an error", () => {
    expect(isParkedResponse(parked() as never)).toBe(true);
    expect(isParkedResponse(executed())).toBe(false);
    expect(isParkedResponse({ error: "No command provided" })).toBe(false);

    expect(isExecutedResponse(executed())).toBe(true);
    expect(isExecutedResponse(parked() as never)).toBe(false);
    expect(isExecutedResponse({ error: "Confirmation expired or already used." })).toBe(false);
  });

  it("does not mistake a half-shaped body for either", () => {
    expect(isParkedResponse({ requires_confirmation: true } as never)).toBe(false);
    expect(isExecutedResponse({ command_id: "a1b2c3d4e5f6" } as never)).toBe(false);
  });
});

describe("describeError", () => {
  it("shows an ApiError's message and hides anything else", () => {
    expect(describeError(new ApiError(500, "The Mac answered with HTTP 500."))).toBe("The Mac answered with HTTP 500.");
    expect(describeError(new Error("ECONNREFUSED 192.168.1.20:8000"))).toBe("Something went wrong. Try again.");
    expect(describeError("boom", "Could not load.")).toBe("Could not load.");
  });
});
