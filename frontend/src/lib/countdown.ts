/**
 * Confirmation countdowns, measured on the Mac's clock.
 *
 * A phone's clock can be minutes off from the Mac's. Instead of comparing
 * expires_at with the phone's Date.now(), the countdown starts from the
 * server_time that came with the response and only uses the phone's clock for
 * time elapsed since that response arrived, which skew does not affect.
 */

export function secondsRemaining(
  expiresAt: number,
  serverTime: number,
  receivedAtMs: number,
  nowMs: number,
): number {
  const elapsed = Math.max(0, nowMs - receivedAtMs) / 1000;
  return Math.max(0, expiresAt - serverTime - elapsed);
}

export function isExpired(remainingSeconds: number): boolean {
  return remainingSeconds <= 0;
}

/** m:ss, rounded up so the display reaches 0:00 exactly when the confirmation expires. */
export function formatCountdown(remainingSeconds: number): string {
  const total = Math.max(0, Math.ceil(remainingSeconds));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Share of the confirmation window left, from 0 to 1. */
export function fractionRemaining(remainingSeconds: number, ttlSeconds: number): number {
  if (!(ttlSeconds > 0)) return 0;
  return Math.min(1, Math.max(0, remainingSeconds / ttlSeconds));
}
