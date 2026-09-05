"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * The current time as an external store, so render stays pure and "due in 3 days" ticks over on
 * its own. The snapshot is floored to the interval, which keeps it stable between ticks; the
 * server snapshot is 0 so server output and the first client paint agree, then the clock starts.
 */
export function useNow(intervalMs = 30_000): number {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const t = setInterval(onChange, intervalMs);
      return () => clearInterval(t);
    },
    [intervalMs],
  );
  return useSyncExternalStore(
    subscribe,
    () => Math.floor(Date.now() / intervalMs) * intervalMs,
    () => 0,
  );
}
