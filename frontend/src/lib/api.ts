/**
 * Typed client for the backend API. Every call is same-origin with a relative
 * path, and every call except the public health check carries the pairing
 * token as a Bearer header.
 */

import type {
  AuditPage,
  AuditQuery,
  CancelResponse,
  ConfirmResponse,
  ExecutedResponse,
  HealthResponse,
  ParkedResponse,
  PendingList,
  Stats,
  TextCommandResponse,
} from "./types";

export class ApiError extends Error {
  /** HTTP status, or 0 when the Mac could not be reached at all. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export const NETWORK_ERROR_MESSAGE =
  "Could not reach the Mac. Check that the server is running and this device is on the same network.";
export const UNAUTHORIZED_MESSAGE = "This device is not paired, or its pairing was revoked.";
export const EXPIRED_MESSAGE = "Confirmation expired or already used — send the command again.";

export interface ApiClientOptions {
  getToken: () => string | null;
  /** Called on any 401, before the request's promise rejects. */
  onUnauthorized?: () => void;
  fetch?: typeof fetch;
}

export interface CallOptions {
  signal?: AbortSignal;
}

interface RequestInit {
  body?: unknown;
  signal?: AbortSignal;
  auth?: boolean;
}

export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

function serverMessage(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const message = (payload as { error?: unknown }).error;
  return typeof message === "string" && message.trim() ? message : null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

export function auditSearch(query: AuditQuery): string {
  const params = new URLSearchParams();
  if (query.limit !== undefined) {
    params.set("limit", String(Math.min(200, Math.max(1, Math.trunc(query.limit)))));
  }
  if (query.before_id !== undefined) params.set("before_id", String(Math.trunc(query.before_id)));
  if (query.decision) params.set("decision", query.decision);
  if (query.command_id) params.set("command_id", query.command_id);
  const search = params.toString();
  return search ? `?${search}` : "";
}

export function createApiClient(options: ApiClientOptions) {
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function request<T>(method: string, path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.auth !== false) {
      const token = options.getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }

    let response: Response;
    try {
      response = await doFetch(path, {
        method,
        headers,
        body,
        signal: init.signal,
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      // The underlying error text varies by browser and is never shown.
      throw new ApiError(0, NETWORK_ERROR_MESSAGE);
    }

    const payload = await readJson(response);
    if (response.status === 401) {
      options.onUnauthorized?.();
      throw new ApiError(401, UNAUTHORIZED_MESSAGE);
    }
    if (!response.ok) {
      throw new ApiError(response.status, serverMessage(payload) ?? `The Mac answered with HTTP ${response.status}.`);
    }
    if (payload === undefined) {
      throw new ApiError(response.status, "The Mac sent a response this app could not read.");
    }
    return payload as T;
  }

  return {
    /** GET / — public, no token. */
    health: (call: CallOptions = {}) =>
      request<HealthResponse>("GET", "/", { auth: false, signal: call.signal }),

    sendCommand: (command: string, clientId: string | null, call: CallOptions = {}) =>
      request<TextCommandResponse>("POST", "/text-command", {
        body: clientId ? { command, client_id: clientId } : { command },
        signal: call.signal,
      }),

    confirm: (pendingId: string, call: CallOptions = {}) =>
      request<ConfirmResponse>("POST", `/confirm/${encodeURIComponent(pendingId)}`, { signal: call.signal }),

    cancel: (pendingId: string, call: CallOptions = {}) =>
      request<CancelResponse>("DELETE", `/pending/${encodeURIComponent(pendingId)}`, { signal: call.signal }),

    listPending: (call: CallOptions = {}) => request<PendingList>("GET", "/pending", { signal: call.signal }),

    audit: (query: AuditQuery = {}, call: CallOptions = {}) =>
      request<AuditPage>("GET", `/audit${auditSearch(query)}`, { signal: call.signal }),

    stats: (call: CallOptions = {}) => request<Stats>("GET", "/stats", { signal: call.signal }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export function isParkedResponse(response: TextCommandResponse): response is ParkedResponse {
  const candidate = response as Partial<ParkedResponse>;
  return candidate.requires_confirmation === true && typeof candidate.pending_id === "string";
}

export function isExecutedResponse(response: TextCommandResponse | ConfirmResponse): response is ExecutedResponse {
  const candidate = response as Partial<ExecutedResponse>;
  return typeof candidate.command_id === "string" && typeof candidate.ok === "boolean";
}

/** A message safe to show for any thrown value. Unknown errors never leak their text. */
export function describeError(error: unknown, fallback = "Something went wrong. Try again."): string {
  return error instanceof ApiError ? error.message : fallback;
}
