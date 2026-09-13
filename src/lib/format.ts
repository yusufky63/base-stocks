import { formatUnits } from "viem";

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdPreciseFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function formatUsd(value: number | null | undefined, opts?: { precise?: boolean }): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (opts?.precise && Math.abs(value) < 1) return usdPreciseFmt.format(value);
  return usdFmt.format(value);
}

export function formatUsdCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (Math.abs(value) < 1000) return usdFmt.format(value);
  return `$${compactFmt.format(value)}`;
}

export function formatPct(value: number | null | undefined, opts?: { sign?: boolean; digits?: number }): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const digits = opts?.digits ?? 2;
  const sign = opts?.sign === false ? "" : value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

/** Format base units with a sensible number of fraction digits. */
export function formatTokenAmount(value: bigint | string | null | undefined, decimals: number, maxFraction = 4): string {
  if (value === null || value === undefined) return "—";
  const n = Number(formatUnits(typeof value === "string" ? BigInt(value) : value, decimals));
  if (!Number.isFinite(n)) return "—";
  const digits = n === 0 ? 0 : n < 0.0001 ? 8 : n < 1 ? 6 : maxFraction;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function shortenAddress(address: string, chars = 4): string {
  if (!address) return "";
  return `${address.slice(0, chars + 2)}…${address.slice(-chars)}`;
}

export function timeAgo(unixMsOrSec: number | null | undefined): string {
  if (!unixMsOrSec) return "—";
  const ms = unixMsOrSec < 1e12 ? unixMsOrSec * 1000 : unixMsOrSec;
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * A length of time in the coarsest unit that still reads honestly: "45s", "12m", "3h", "4d".
 * Negative or non-finite input is a zero duration.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * How far a future moment is: "in 3h", or "now" once it has passed. `timeAgo` clamps a future
 * time to "0s ago", which is how a plan due next week came to read "Next run 0s from now".
 */
export function timeUntil(unixMsOrSec: number | null | undefined, now = Date.now()): string {
  if (!unixMsOrSec) return "—";
  const ms = unixMsOrSec < 1e12 ? unixMsOrSec * 1000 : unixMsOrSec;
  const diff = ms - now;
  if (diff <= 0) return "now";
  return `in ${formatDuration(diff)}`;
}

export function bpsToPct(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
}

export function formatWeiUsd(wei: string | bigint | null | undefined, ethUsd: number | null): number | null {
  if (wei === null || wei === undefined || ethUsd === null) return null;
  return Number(formatUnits(typeof wei === "string" ? BigInt(wei) : wei, 18)) * ethUsd;
}
