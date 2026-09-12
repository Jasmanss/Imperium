"use client";

import { useEffect, useState } from "react";

/**
 * The local clock (ms), refreshed every intervalMs while active. It starts
 * from initialMs, a time recorded outside render, and catches up on the next
 * tick, so rendering stays pure.
 *
 * Pass stopAtMs when nothing changes after a known moment — an expired
 * countdown, say. The clock ticks once past it and then stops, instead of
 * re-rendering the same thing every second for as long as it stays on screen.
 */
export function useNow(initialMs: number, intervalMs = 1000, active = true, stopAtMs = Infinity): number {
  const [now, setNow] = useState(initialMs);

  useEffect(() => {
    if (!active) return;
    const tick = () => {
      const value = Date.now();
      setNow(value);
      // `interval` exists by the time a timer can run this.
      if (value >= stopAtMs) clearInterval(interval);
    };
    const first = setTimeout(tick, 0);
    const interval = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [intervalMs, active, stopAtMs]);

  return now;
}
