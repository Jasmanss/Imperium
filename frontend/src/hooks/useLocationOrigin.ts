"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** window.location.origin, or "" while prerendering. */
export function useLocationOrigin(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.origin,
    () => "",
  );
}
