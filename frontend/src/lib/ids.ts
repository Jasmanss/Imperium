const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const COMMAND_ID_PATTERN = /^[0-9a-f]{12}$/;

export function isValidClientId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_ID_PATTERN.test(value);
}

export function isCommandId(value: unknown): value is string {
  return typeof value === "string" && COMMAND_ID_PATTERN.test(value);
}

/**
 * A random client_id for one command. crypto.randomUUID only exists in secure
 * contexts, and the app is usually served over plain http on the LAN, so this
 * uses getRandomValues, which is available everywhere.
 */
export function newClientId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `web-${hex}`;
}
