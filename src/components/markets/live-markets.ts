import type { AssetsResponse } from "@/lib/client-api";
import { tradingStatus, type TradingStatus } from "@/lib/trading-status";

/** One row of the markets list: the asset and whatever price view the snapshot holds for it. */
export type MarketRow = { asset: AssetsResponse["assets"][number]; price?: AssetsResponse["prices"][string] };

/**
 * "Live" for the purpose of a headline count or a total: a pool deep enough to trade against. Thin
 * markets count, very thin ones do not, which is the same line the Buy buttons draw. Written once
 * here because Home, Markets and the heatmap each used to spell it out and could have disagreed.
 */
export function isLiveMarket(status: TradingStatus): boolean {
  return status === "tradable" || status === "thin";
}

export function liveMarketRows(rows: MarketRow[]): MarketRow[] {
  return rows.filter((r) => isLiveMarket(tradingStatus(r.asset, r.price).status));
}

export interface LiveMarketTotals {
  /** The live rows themselves, for callers that go on to render them. */
  live: MarketRow[];
  liquidityUsd: number;
  volume24hUsd: number;
  /** Live markets whose 24h move is positive. */
  up: number;
  /** False when no row carries any liquidity figure: a bad minute upstream, or the first render. That is "unknown", not "none live". */
  known: boolean;
}

export function liveMarketTotals(rows: MarketRow[]): LiveMarketTotals {
  const live = liveMarketRows(rows);
  return {
    live,
    liquidityUsd: live.reduce((sum, r) => sum + (r.price?.liquidityUsd ?? 0), 0),
    volume24hUsd: live.reduce((sum, r) => sum + (r.price?.volume24hUsd ?? 0), 0),
    up: live.filter((r) => (r.price?.marketChange24hPct ?? 0) > 0).length,
    known: rows.some((r) => r.price?.liquidityUsd !== null && r.price?.liquidityUsd !== undefined),
  };
}

/**
 * The liquidity lines the status labels are drawn at. `trading-status.ts` keeps these private; the
 * values are mirrored here for the legend and pinned by a test that probes `tradingStatus()` at the
 * boundaries, so a change there fails loudly instead of leaving the Markets footnote lying.
 */
export const LIQUID_USD = 100_000;
export const THIN_USD = 10_000;

/** A definitely issued, active asset: what every status except not-issued and paused is judged on. */
const ISSUED = { status: "active", totalSupply: "1", supplyKnown: true } as const;

function compactUsd(n: number): string {
  return n >= 1_000_000 ? `$${n / 1_000_000}M` : `$${Math.round(n / 1_000)}k`;
}

/**
 * The legend under the Markets list, generated from `tradingStatus()` so the labels are the very
 * strings the chips use. The display-price rule quotes the price service's own gate: the pool price
 * is the headline only within 20% of a live Chainlink reference and with at least $20k of depth.
 */
export function marketLegend(): string {
  const label = (status: TradingStatus) => {
    switch (status) {
      case "tradable":
        return tradingStatus(ISSUED, { liquidityUsd: LIQUID_USD, volume24hUsd: null }).label;
      case "thin":
        return tradingStatus(ISSUED, { liquidityUsd: THIN_USD, volume24hUsd: null }).label;
      case "very-thin":
        return tradingStatus(ISSUED, { liquidityUsd: 1, volume24hUsd: null }).label;
      case "no-pool":
        return tradingStatus(ISSUED, { liquidityUsd: 0, volume24hUsd: null }).label;
      case "not-issued":
        return tradingStatus({ status: "active", totalSupply: "0", supplyKnown: true }, null).label;
      case "paused":
        return tradingStatus({ status: "paused", totalSupply: "1", supplyKnown: true }, null).label;
    }
  };
  const statuses = [
    `${label("tradable")} = a DEX pool with ${compactUsd(LIQUID_USD)}+ liquidity`,
    `${label("thin")} = ${compactUsd(THIN_USD)}–${compactUsd(LIQUID_USD)}`,
    `${label("very-thin")} = under ${compactUsd(THIN_USD)}, expect heavy slippage`,
    `${label("no-pool")} = issued, but no DEX pool with liquidity`,
    `${label("not-issued")} = the contract exists but Coinbase has not minted tokens on Base`,
    `${label("paused")} = transfers paused by the issuer`,
  ].join("; ");
  return `${statuses}. The pool price is shown only while it sits within 20% of a live Chainlink reference and the pool holds at least $20k; otherwise the reference is shown and marked. Executable prices come from a live quote when you trade.`;
}
