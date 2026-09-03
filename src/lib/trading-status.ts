import type { B20AssetDTO } from "@/domain/asset";
import type { PriceView } from "@/domain/market";

/**
 * "Deployed != tradable" (integration guide §6–8). A stock is shown as live only when the token
 * exists onchain AND a DEX pool with meaningful liquidity is reported by market data; everything
 * else is labelled honestly and sorted behind the live ones.
 */
export type TradingStatus = "tradable" | "thin" | "no-pool" | "not-issued" | "paused";

export interface TradingStatusView {
  status: TradingStatus;
  /** Short label for chips: "Live", "Thin", "No pool yet", "Not issued yet", "Paused". */
  label: string;
  /** Extra detail for tooltips / cards, e.g. "$1.7M liquidity · $6.2M 24h". */
  detail: string;
  tone: "positive" | "warning" | "neutral" | "danger";
  rank: number;
}

const LIQUID_USD = 100_000;
const THIN_USD = 10_000;

function compactUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

export function tradingStatus(asset: Pick<B20AssetDTO, "status" | "totalSupply">, price?: Pick<PriceView, "liquidityUsd" | "volume24hUsd"> | null): TradingStatusView {
  if (asset.status === "paused") return { status: "paused", label: "Paused", detail: "Transfers paused by the issuer", tone: "danger", rank: 4 };
  if (BigInt(asset.totalSupply ?? "0") === 0n) return { status: "not-issued", label: "Not issued yet", detail: "No tokens minted on Base yet", tone: "neutral", rank: 3 };
  const liq = price?.liquidityUsd ?? 0;
  const vol = price?.volume24hUsd ?? null;
  const volText = vol !== null && vol > 0 ? ` · ${compactUsd(vol)} 24h` : "";
  if (liq >= LIQUID_USD) return { status: "tradable", label: "Live", detail: `${compactUsd(liq)} liquidity${volText}`, tone: "positive", rank: 0 };
  if (liq >= THIN_USD) return { status: "thin", label: "Thin", detail: `${compactUsd(liq)} liquidity${volText}`, tone: "warning", rank: 1 };
  return { status: "no-pool", label: "No pool yet", detail: liq > 0 ? `${compactUsd(liq)} liquidity` : "Issued, but no DEX pool with liquidity", tone: "neutral", rank: 2 };
}

/** Stable ordering: live markets first, then thin, no-pool, not-issued, paused; ties keep the input order. */
export function sortByTradingStatus<T>(items: T[], pick: (item: T) => { asset: Pick<B20AssetDTO, "status" | "totalSupply">; price?: Pick<PriceView, "liquidityUsd" | "volume24hUsd"> | null }): T[] {
  return items
    .map((item, i) => ({ item, i, rank: tradingStatus(pick(item).asset, pick(item).price).rank }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.item);
}
