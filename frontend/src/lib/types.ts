/**
 * The Imperium v3 API contract, as seen by the frontend.
 *
 * Everything is same-origin. Times are Unix epoch seconds (floats). command_id
 * is 12 lowercase hex characters assigned by the server when a command arrives
 * and kept through parking, confirmation, execution, audit rows, and events.
 * client_id is chosen by this app for each command it sends.
 */

export type Decision =
  | "pending_confirmation"
  | "confirmed"
  | "cancelled"
  | "executed"
  | "failed"
  | "script_blocked";

export const DECISIONS: readonly Decision[] = [
  "executed",
  "failed",
  "script_blocked",
  "pending_confirmation",
  "confirmed",
  "cancelled",
];

export type KnownTier = "read" | "act" | "destructive";

export interface DetailRow {
  label: string;
  value: string;
}

export interface ErrorResponse {
  error: string;
}

/** A destructive command parked until the user confirms it, as listed by GET /pending. */
export interface ParkedCommand {
  requires_confirmation: true;
  pending_id: string;
  command_id: string;
  client_id: string | null;
  command: string;
  category: string;
  tier: string;
  details: DetailRow[];
  created_at: number;
  expires_at: number;
  ttl_seconds: number;
  server_time: number;
}

/** POST /text-command response for a command parked for confirmation. */
export interface ParkedResponse extends ParkedCommand {
  transcript: string;
  action: string;
}

/** Response for a command that ran: the handler's own keys plus execution metadata. */
export interface ExecutedResponse {
  command_id: string;
  client_id: string | null;
  ok: boolean;
  duration_ms: number;
  audit_id: number | null;
  transcript?: string;
  action?: string | null;
  error?: string | null;
  osascript_ok?: boolean | null;
  osascript_error?: string | null;
  result?: string | null;
  visual_typing?: boolean;
}

export type TextCommandResponse = ParkedResponse | ExecutedResponse | ErrorResponse;

export type ConfirmResponse = ExecutedResponse | ErrorResponse;

export interface CancelResponse {
  cancelled: true;
  pending_id: string;
  command_id: string;
}

export interface PendingList {
  pending: ParkedCommand[];
  server_time: number;
}

export interface AuditRow {
  id: number;
  ts: number;
  command: string | null;
  category: string | null;
  tier: string | null;
  decision: Decision;
  script: string | null;
  error: string | null;
  ok: 1 | 0 | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  api_calls: number | null;
  /** Comma-separated model names. */
  models: string | null;
  repair_attempts: number | null;
  repair_succeeded: 1 | 0 | null;
  command_id: string | null;
  action: string | null;
}

export interface AuditPage {
  entries: AuditRow[];
  next_before_id: number | null;
}

export interface AuditQuery {
  limit?: number;
  before_id?: number;
  decision?: Decision;
  command_id?: string;
}

export interface CategoryStats {
  category: string;
  n: number;
  ok_n: number;
  p95_latency_ms: number | null;
  input_tokens: number;
  output_tokens: number;
}

export interface Stats {
  commands: number;
  success_rate: number | null;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  repair_attempts: number;
  commands_saved_by_repair: number;
  scripts_blocked_by_policy: number;
  parked_for_confirmation: number;
  confirmed: number;
  cancelled: number;
  by_category: CategoryStats[];
}

export interface HealthResponse {
  status: string;
}

// ---------------------------------------------------------------------------
// Event stream (GET /events)
// ---------------------------------------------------------------------------

export interface HelloEvent {
  type: "hello";
  ts: number;
  boot_id: string;
  server_time: number;
}

interface CommandScoped {
  ts: number;
  command_id: string;
  client_id: string | null;
}

export interface CommandEvent extends CommandScoped {
  type: "command";
  command: string;
  category: string;
  tier: string;
}

export interface PendingEvent extends CommandScoped {
  type: "pending";
  pending_id: string;
  category: string;
  tier: string;
  details: DetailRow[];
  expires_at: number;
}

export interface ConfirmedEvent extends CommandScoped {
  type: "confirmed";
  pending_id: string;
}

export interface CancelledEvent extends CommandScoped {
  type: "cancelled";
  pending_id: string;
}

export interface StartedEvent extends CommandScoped {
  type: "started";
  category: string;
  tier: string;
}

export interface ModelCallEvent extends CommandScoped {
  type: "model_call";
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export interface ScriptEvent extends CommandScoped {
  type: "script";
  /** The first 400 characters of the script. */
  preview: string;
  length: number;
}

export interface PolicyBlockedEvent extends CommandScoped {
  type: "policy_blocked";
  reason: string;
}

export interface RepairEvent extends CommandScoped {
  type: "repair";
  attempt: number;
  /** At most 300 characters. */
  error: string;
}

export interface FinishedEvent extends CommandScoped {
  type: "finished";
  ok: boolean;
  action: string | null;
  error: string | null;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  repair_attempts: number;
  repair_succeeded: boolean | null;
  audit_id: number | null;
}

export type CommandStreamEvent =
  | CommandEvent
  | PendingEvent
  | ConfirmedEvent
  | CancelledEvent
  | StartedEvent
  | ModelCallEvent
  | ScriptEvent
  | PolicyBlockedEvent
  | RepairEvent
  | FinishedEvent;

export type CommandStreamEventType = CommandStreamEvent["type"];

export type ServerEvent = HelloEvent | CommandStreamEvent;
