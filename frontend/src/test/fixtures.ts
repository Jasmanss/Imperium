/** Builders for the API and event shapes the tests drive the app with. */

import type { AuditPage, AuditRow, CommandStreamEvent, ExecutedResponse, ParkedCommand } from "@/lib/types";

export function parked(overrides: Partial<ParkedCommand> = {}): ParkedCommand {
  return {
    requires_confirmation: true,
    pending_id: "pend-1",
    command_id: "a1b2c3d4e5f6",
    client_id: "c-1",
    command: "text 555-0100 saying on my way",
    category: "message_send",
    tier: "destructive",
    details: [{ label: "To", value: "555-0100" }],
    created_at: 1_700_000_000,
    expires_at: 1_700_000_120,
    ttl_seconds: 120,
    server_time: 1_700_000_000,
    ...overrides,
  };
}

export function executed(overrides: Partial<ExecutedResponse> = {}): ExecutedResponse {
  return {
    command_id: "a1b2c3d4e5f6",
    client_id: "c-1",
    ok: true,
    duration_ms: 420,
    audit_id: 7,
    action: "Opened Notes",
    ...overrides,
  };
}

export function auditRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: 1,
    ts: 1_700_000_000,
    command: "open notes",
    category: "app_open",
    tier: "act",
    decision: "executed",
    script: 'tell application "Notes" to activate',
    error: null,
    ok: 1,
    duration_ms: 320,
    input_tokens: 900,
    output_tokens: 40,
    api_calls: 1,
    models: "claude-sonnet-4",
    repair_attempts: 0,
    repair_succeeded: null,
    command_id: "a1b2c3d4e5f6",
    action: "Opened Notes",
    ...overrides,
  };
}

/** An audit page of rows with descending ids, newest `newest` first. */
export function auditPage(ids: readonly number[], nextBeforeId: number | null = null): AuditPage {
  return { entries: ids.map((id) => auditRow({ id })), next_before_id: nextBeforeId };
}

export function commandEvent(overrides: Partial<CommandStreamEvent> = {}): CommandStreamEvent {
  return {
    type: "command",
    ts: 1_700_000_000,
    command_id: "a1b2c3d4e5f6",
    client_id: "c-1",
    command: "open notes",
    category: "app_open",
    tier: "act",
    ...overrides,
  } as CommandStreamEvent;
}

/** A Response the fetch stubs return, without needing a real network stack. */
export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
