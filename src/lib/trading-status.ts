import type { B20AssetDTO } from "@/domain/asset";
import type { PriceView } from "@/domain/market";

/**
 * "Deployed != tradable" (integration guide §6–8). A stock is shown as live only when the token
 * exists onchain AND a DEX pool with meaningful liquidity is reported by market data; everything
 * else is labelled honestly and sorted behind the live ones.
 */
export type TradingStatus = "tradable" | "thin" | "very-thin" | "no-pool" | "not-issued" | "paused";

export interface TradingStatusView {
  status: TradingStatus;
  /** Short label for chips: "Live", "Thin", "Very thin", "No pool yet", "Not issued yet", "Paused". */
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
  if (asset.status === "paused") return { status: "paused", label: "Paused", detail: "Transfers paused by the issuer", tone: "danger", rank: 5 };
  if (BigInt(asset.totalSupply ?? "0") === 0n) return { status: "not-issued", label: "Not issued yet", detail: "No tokens minted on Base yet", tone: "neutral", rank: 4 };
  const liq = price?.liquidityUsd ?? 0;
  const vol = price?.volume24hUsd ?? null;
  const volText = vol !== null && vol > 0 ? ` · ${compactUsd(vol)} 24h` : "";
  if (liq >= LIQUID_USD) return { status: "tradable", label: "Live", detail: `${compactUsd(liq)} liquidity${volText}`, tone: "positive", rank: 0 };
  if (liq >= THIN_USD) return { status: "thin", label: "Thin", detail: `${compactUsd(liq)} liquidity${volText}`, tone: "warning", rank: 1 };
  // A pool that exists but is tiny is not "no pool yet" — saying so while printing its size in the
  // same breath reads as a bug, and it is the state most of a freshly listed stock's day is spent in.
  if (liq > 0) return { status: "very-thin", label: "Very thin", detail: `${compactUsd(liq)} liquidity — expect heavy slippage${volText}`, tone: "warning", rank: 2 };
  return { status: "no-pool", label: "No pool yet", detail: "Issued, but no DEX pool with liquidity", tone: "neutral", rank: 3 };
}

/** Stable ordering: live first, then thin, very thin, no-pool, not-issued, paused; ties keep the input order. */
export function sortByTradingStatus<T>(items: T[], pick: (item: T) => { asset: Pick<B20AssetDTO, "status" | "totalSupply">; price?: Pick<PriceView, "liquidityUsd" | "volume24hUsd"> | null }): T[] {
  return items
    .map((item, i) => ({ item, i, rank: tradingStatus(pick(item).asset, pick(item).price).rank }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.item);
}

/**
 * Whether a 24h move from this market means anything. Only a market with real depth qualifies.
 *
 * A pool younger than a day has no honest "24h ago" to compare against: on the day six stocks
 * listed, the DEX reported Microsoft down 82% while its pool price sat 1% from the Chainlink
 * reference. The first cut of this drew the line at Thin, and Amazon slipped through at $10,071
 * of depth still claiming −63% while Microsoft was blocked at $9,979 — seventy-one dollars of
 * liquidity is not the difference between a real move and an artifact.
 *
 * So the line is depth, not almost-depth. At $28k a single $3k trade moves the price ten percent,
 * which is a fact about one trade and not about the stock. Thin markets keep everything else —
 * price, liquidity, the Chainlink reference beside it — and simply do not assert a daily move.
 */
export function hasMeaningfulChange(status: TradingStatus): boolean {
  return status === "tradable";
}
