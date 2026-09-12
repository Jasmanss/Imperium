/**
 * Pairing token storage.
 *
 * The Mac prints a QR code for http://<mac>:8000/app#token=<token>. The token
 * travels in the URL fragment, which browsers never send to the server, and is
 * kept in localStorage under the key the v2 page used, so phones paired before
 * v3 stay paired. It is only ever sent as an Authorization header: never in a
 * URL, a query string, console output, or an error message.
 */

export const TOKEN_STORAGE_KEY = "imperium_token";

const FRAGMENT_PREFIX = "#token=";

// Visible ASCII only: anything else cannot be sent in an HTTP header.
const TOKEN_PATTERN = /^[\x21-\x7e]{1,512}$/;

export function isValidToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Storage can throw when it is disabled (some private modes, blocked cookies).
    return null;
  }
}

export function readToken(): string | null {
  try {
    const value = storage()?.getItem(TOKEN_STORAGE_KEY) ?? null;
    return value !== null && isValidToken(value) ? value : null;
  } catch {
    return null;
  }
}

/** Store a token; returns false when it is invalid or storage is unavailable. */
export function saveToken(token: string): boolean {
  const value = token.trim();
  if (!isValidToken(value)) return false;
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(TOKEN_STORAGE_KEY, value);
  } catch {
    return false;
  }
  notify();
  return true;
}

export function clearToken(): void {
  try {
    storage()?.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Nothing stored, or storage is unavailable: either way no token remains usable.
  }
  notify();
}

/** Subscribe to token changes in this tab and in other tabs of the app. */
export function subscribeToken(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === TOKEN_STORAGE_KEY) listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function hasTokenFragment(hash: string): boolean {
  return hash.startsWith(FRAGMENT_PREFIX);
}

/** The token carried by a "#token=..." fragment, or null. */
export function tokenFromFragment(hash: string): string | null {
  if (!hasTokenFragment(hash)) return null;
  const value = hash.slice(FRAGMENT_PREFIX.length).trim();
  return isValidToken(value) ? value : null;
}

/**
 * Accept what a user pastes on the pairing screen: the full pairing link, just
 * its "#token=..." fragment, or the bare token.
 */
export function parsePairingInput(input: string): { token: string } | { error: string } {
  const value = input.trim();
  if (value === "") return { error: "Paste the pairing link or token." };
  const marker = value.indexOf(FRAGMENT_PREFIX);
  if (marker !== -1) {
    const token = tokenFromFragment(value.slice(marker));
    return token ? { token } : { error: "That link has no usable pairing token." };
  }
  if (/^https?:\/\//i.test(value)) {
    return { error: "That link has no pairing token. Copy the full link printed in the Mac terminal." };
  }
  return isValidToken(value)
    ? { token: value }
    : { error: "A pairing token has no spaces or line breaks. Copy it again from the Mac terminal." };
}

/**
 * If the page was opened from a pairing link, store its token. Returns true
 * when a token was stored. The fragment itself is removed by stripTokenFragment.
 */
export function captureTokenFromLocation(location: Pick<Location, "hash">): boolean {
  const token = tokenFromFragment(location.hash);
  return token !== null && saveToken(token);
}

/**
 * Remove a "#token=..." fragment from the address bar and the current history
 * entry. Passing null state lets Next.js's router adopt the new URL, so it never
 * restores the old one with the token still in it.
 */
export function stripTokenFragment(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState">,
): boolean {
  if (!hasTokenFragment(location.hash)) return false;
  try {
    history.replaceState(null, "", location.pathname + location.search);
    return true;
  } catch {
    return false;
  }
}
