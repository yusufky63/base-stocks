"use client";

import { useEffect, useReducer, useSyncExternalStore } from "react";
import { timeAgo } from "@/lib/format";

const noop = () => () => {};

/**
 * Relative time that only renders on the client (the server prints a stable placeholder), so
 * "57s ago" vs "1m ago" can never cause a hydration mismatch. Re-renders every 30s to stay fresh.
 */
export function TimeAgo({ value, placeholder = "", className }: { value: number | null | undefined; placeholder?: string; className?: string }) {
  const isClient = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, []);
  if (!isClient || !value) return <span className={className}>{placeholder}</span>;
  return <span className={className}>{timeAgo(value)}</span>;
}
