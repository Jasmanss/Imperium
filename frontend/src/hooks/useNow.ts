"use client";

import { useEffect, useState } from "react";

/**
 * The local clock (ms), refreshed every intervalMs while active. It starts
 * from initialMs, a time recorded outside render, and catches up on the next
 * tick, so rendering stays pure.
 */
export function useNow(initialMs: number, intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(initialMs);

  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const interval = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [intervalMs, active]);

  return now;
}
