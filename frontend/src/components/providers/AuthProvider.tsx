"use client";

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { BootScreen } from "@/components/BootScreen";
import { PairingScreen, type RetryOutcome } from "@/components/PairingScreen";
import { ApiError, createApiClient, type ApiClient } from "@/lib/api";
import {
  captureTokenFromLocation,
  clearToken,
  readToken,
  saveToken,
  stripTokenFragment,
  subscribeToken,
} from "@/lib/token";

interface AuthContextValue {
  api: ApiClient;
  /** Report a 401 seen outside the API client, such as on the event stream. */
  markUnauthorized: () => void;
  unpair: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}

// The token only exists in this browser, so while prerendering and hydrating
// it is unknown and the gate renders a neutral boot screen.
const unknownToken = (): undefined => undefined;

export function AuthProvider({ children, fetchImpl }: { children: ReactNode; fetchImpl?: typeof fetch }) {
  const token = useSyncExternalStore(subscribeToken, readToken, unknownToken);
  // The token the Mac rejected with a 401. A newly paired token is not rejected.
  const [rejectedToken, setRejectedToken] = useState<string | null>(null);

  const markUnauthorized = useCallback(() => setRejectedToken(readToken()), []);

  const api = useMemo(
    () => createApiClient({ getToken: readToken, onUnauthorized: markUnauthorized, fetch: fetchImpl }),
    [markUnauthorized, fetchImpl],
  );

  useLayoutEffect(() => {
    // Opened from a pairing link: store the token before any screen renders or
    // any request goes out.
    captureTokenFromLocation(window.location);
  }, []);

  useEffect(() => {
    // Remove the fragment on a later task. By then Next.js's router has
    // installed its history.replaceState integration (in its own effect, which
    // runs after this one), so the router adopts the clean URL too.
    const strip = () => stripTokenFragment(window.location, window.history);
    const timer = window.setTimeout(strip, 0);
    // A pairing link opened in an already-loaded tab only changes the hash.
    const onHashChange = () => {
      captureTokenFromLocation(window.location);
      strip();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  const pair = useCallback((value: string) => {
    const saved = saveToken(value);
    if (saved) setRejectedToken(null);
    return saved;
  }, []);

  const unpair = useCallback(() => {
    clearToken();
    setRejectedToken(null);
  }, []);

  const retry = useCallback(async (): Promise<RetryOutcome> => {
    try {
      await api.listPending();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return "rejected";
      // Any other HTTP answer means the token got past authentication.
      if (!(error instanceof ApiError) || error.status === 0) return "unreachable";
    }
    setRejectedToken(null);
    return "accepted";
  }, [api]);

  const context = useMemo(() => ({ api, markUnauthorized, unpair }), [api, markUnauthorized, unpair]);

  let content: ReactNode;
  if (token === undefined) {
    content = <BootScreen />;
  } else if (token === null) {
    content = <PairingScreen mode="unpaired" onPair={pair} />;
  } else if (token === rejectedToken) {
    content = <PairingScreen mode="rejected" onPair={pair} onRetry={retry} onForget={unpair} />;
  } else {
    // Keyed by token: pairing again remounts the app with a fresh event stream.
    content = <Fragment key={token}>{children}</Fragment>;
  }

  return <AuthContext.Provider value={context}>{content}</AuthContext.Provider>;
}
