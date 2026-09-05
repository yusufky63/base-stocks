import type { Address } from "viem";
import { MIN_TRADE_USD } from "@/config/chain";
import { TOTAL_BPS, USDC_ALLOCATION_KEY, type Allocation, type AllocationTarget, type PortfolioSnapshot } from "@/domain/portfolio";

/**
 * Drift, measured one way everywhere.
 *
 * The base a weight is measured against is the money a rebalance can actually move: the stocks,
 * plus cash only when the target says how much cash to hold. USDC in Earn and liquidity positions
 * are never part of it — a rebalance does not withdraw from a vault or close a pool — and the page
 * says so. The Overview banner, the Rebalance table and the trades it proposes all read from here,
 * so they cannot disagree about whether the mix has drifted.
 */

/** A leg trades only when it is at least this far out, in dollars and in share of the base. */
export const REBALANCE_MIN_USD = 5;
export const REBALANCE_MIN_BPS = 100;

export type DriftAction = "buy" | "sell" | "hold" | "spend" | "keep";

export interface DriftRow {
  assetAddress: AllocationTarget;
  symbol: string;
  currentUsd: number;
  currentBps: number;
  targetBps: number;
  targetUsd: number;
  /** Positive = more of it is wanted. */
  deltaUsd: number;
  /** Stocks buy / sell / hold; cash is spent or kept, never "sold". */
  action: DriftAction;
  /** Set when the leg is out of line but cannot trade today (no pool, not issued, too thin). */
  blocked?: string;
  /** True when the stock is held today. */
  held: boolean;
}

export function stockValue(snapshot: Pick<PortfolioSnapshot, "holdings">): number {
  return snapshot.holdings.reduce((s, h) => s + h.marketValueUsd, 0);
}

export function targetHasCash(target: Allocation[]): boolean {
  return target.some((a) => a.assetAddress === USDC_ALLOCATION_KEY && a.weightBps > 0);
}

/** The value the target's weights apply to. */
export function driftBase(snapshot: Pick<PortfolioSnapshot, "holdings" | "usdcValueUsd">, target: Allocation[]): number {
  return stockValue(snapshot) + (targetHasCash(target) ? snapshot.usdcValueUsd : 0);
}

/**
 * The stocks held now as weights that add to exactly 100%. Cash is left out on purpose: a saved
 * "today's mix" says which stocks to hold in what proportion, not how much to leave uninvested.
 */
export function currentMix(snapshot: Pick<PortfolioSnapshot, "holdings">): Allocation[] {
  const priced = snapshot.holdings.filter((h) => h.marketValueUsd > 0);
  const total = priced.reduce((s, h) => s + h.marketValueUsd, 0);
  if (total <= 0 || priced.length === 0) return [];
  const out: Allocation[] = priced.map((h) => ({ assetAddress: h.assetAddress, weightBps: Math.max(1, Math.round((h.marketValueUsd / total) * TOTAL_BPS)) }));
  const drift = TOTAL_BPS - out.reduce((s, a) => s + a.weightBps, 0);
  if (drift !== 0) {
    const biggest = out.reduce((best, a, i) => (a.weightBps > out[best]!.weightBps ? i : best), 0);
    out[biggest]!.weightBps += drift;
  }
  return out;
}

/** Worst leg in basis points, or null when there is nothing to compare. */
export function maxDriftBps(snapshot: Pick<PortfolioSnapshot, "holdings" | "usdcValueUsd">, target: Allocation[] | null): number | null {
  if (!target || target.length === 0) return null;
  const base = driftBase(snapshot, target);
  if (base <= 0) return null;
  let worst = 0;
  const seen = new Set<string>();
  const cash = targetHasCash(target);
  for (const a of target) {
    const key = keyOf(a.assetAddress);
    // A cash leg only counts when the target actually holds cash; a zero-weight one is no leg at all.
    if (key === USDC_ALLOCATION_KEY && !cash) continue;
    seen.add(key);
    const currentUsd = key === USDC_ALLOCATION_KEY ? snapshot.usdcValueUsd : (snapshot.holdings.find((h) => h.assetAddress.toLowerCase() === key)?.marketValueUsd ?? 0);
    worst = Math.max(worst, Math.abs(Math.round((currentUsd / base) * TOTAL_BPS) - a.weightBps));
  }
  // A stock held outside the target is drift too: its whole weight is unwanted.
  for (const h of snapshot.holdings) {
    if (h.marketValueUsd > 0 && !seen.has(h.assetAddress.toLowerCase())) worst = Math.max(worst, Math.round((h.marketValueUsd / base) * TOTAL_BPS));
  }
  return worst;
}

export interface DriftOptions {
  symbolFor?: (address: string) => string | undefined;
  /** Why a leg cannot trade today, from the shared eligibility rule; null = fine. */
  blockedFor?: (side: "buy" | "sell", address: string, usd: number) => string | null;
  minUsd?: number;
  minBps?: number;
}

/**
 * One row per stock in the target or the wallet, plus a cash row when the target holds cash.
 * Sorted by how far out each leg is.
 */
export function driftRows(snapshot: Pick<PortfolioSnapshot, "holdings" | "usdcValueUsd">, target: Allocation[], opts: DriftOptions = {}): DriftRow[] {
  const base = driftBase(snapshot, target);
  if (base <= 0) return [];
  const minUsd = Math.max(MIN_TRADE_USD, opts.minUsd ?? REBALANCE_MIN_USD);
  const minBps = opts.minBps ?? REBALANCE_MIN_BPS;
  const threshold = Math.max(minUsd, (base * minBps) / TOTAL_BPS);
  const targetMap = new Map(target.map((t) => [keyOf(t.assetAddress), t.weightBps]));
  const keys = new Set<string>([...targetMap.keys(), ...snapshot.holdings.filter((h) => h.marketValueUsd > 0).map((h) => h.assetAddress.toLowerCase())]);
  if (!targetHasCash(target)) keys.delete(USDC_ALLOCATION_KEY);

  const rows: DriftRow[] = [];
  for (const key of keys) {
    const cash = key === USDC_ALLOCATION_KEY;
    const holding = cash ? undefined : snapshot.holdings.find((h) => h.assetAddress.toLowerCase() === key);
    const currentUsd = cash ? snapshot.usdcValueUsd : (holding?.marketValueUsd ?? 0);
    const targetBps = targetMap.get(key) ?? 0;
    const targetUsd = (targetBps / TOTAL_BPS) * base;
    const deltaUsd = targetUsd - currentUsd;
    const small = Math.abs(deltaUsd) < threshold;
    let action: DriftAction = "hold";
    if (!small) action = cash ? (deltaUsd > 0 ? "keep" : "spend") : deltaUsd > 0 ? "buy" : "sell";
    const address = cash ? USDC_ALLOCATION_KEY : ((holding?.assetAddress ?? (target.find((t) => keyOf(t.assetAddress) === key)?.assetAddress as Address) ?? (key as Address)) as Address);
    const blocked = !cash && (action === "buy" || action === "sell") ? (opts.blockedFor?.(action, key, Math.abs(deltaUsd)) ?? null) : null;
    rows.push({
      assetAddress: address,
      symbol: cash ? "USDC" : (holding?.underlying ?? opts.symbolFor?.(key) ?? `${key.slice(0, 6)}…${key.slice(-4)}`),
      currentUsd,
      currentBps: Math.round((currentUsd / base) * TOTAL_BPS),
      targetBps,
      targetUsd,
      deltaUsd,
      action,
      blocked: blocked ?? undefined,
      held: cash ? snapshot.usdcValueUsd > 0 : !!holding,
    });
  }
  return rows.sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd));
}

export interface DriftSummary {
  base: number;
  sellsUsd: number;
  buysUsd: number;
  /** Buys that cannot run today, and why. */
  blockedUsd: number;
  /** Cash on hand after the sells, before the buys. */
  cashAfterSells: number;
  /** Buys not covered by cash after the sells. */
  shortfallUsd: number;
  trades: number;
  inBalance: boolean;
}

export function driftSummary(snapshot: Pick<PortfolioSnapshot, "holdings" | "usdcValueUsd">, target: Allocation[], rows: DriftRow[]): DriftSummary {
  const runnable = rows.filter((r) => !r.blocked);
  const sellsUsd = runnable.filter((r) => r.action === "sell").reduce((s, r) => s + Math.abs(r.deltaUsd), 0);
  const buysUsd = runnable.filter((r) => r.action === "buy").reduce((s, r) => s + r.deltaUsd, 0);
  const blockedUsd = rows.filter((r) => r.blocked).reduce((s, r) => s + Math.abs(r.deltaUsd), 0);
  const cashAfterSells = snapshot.usdcValueUsd + sellsUsd;
  return {
    base: driftBase(snapshot, target),
    sellsUsd,
    buysUsd,
    blockedUsd,
    cashAfterSells,
    shortfallUsd: Math.max(0, buysUsd - cashAfterSells),
    trades: runnable.filter((r) => r.action === "buy" || r.action === "sell").length,
    inBalance: rows.every((r) => r.action === "hold"),
  };
}

function keyOf(a: AllocationTarget): string {
  return a === USDC_ALLOCATION_KEY ? USDC_ALLOCATION_KEY : a.toLowerCase();
}
