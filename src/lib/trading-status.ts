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
/** Deep enough that a large daily move is news rather than one order against a thin book. */
const DEEP_USD = 1_000_000;
/** Below DEEP_USD, the largest daily move still credited to the stock rather than to a single trade. */
const MAX_THIN_MOVE_PCT = 25;
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
 *
 * Depth alone turned out not to be enough. Amazon at $111k of liquidity cleared the bar and then
 * reported −68% for the day, and Strategy did the same at $110k: past the line by ten thousand
 * dollars, and still a book thin enough that one trade wrote the number. A competitor's table
 * prints exactly these, next to the real ones, with nothing to tell them apart.
 *
 * So the size of the move is weighed against the depth that produced it. Past a million of
 * liquidity a large move is treated as news, because a book that deep does not swing on one order.
 * Under it, a move beyond a quarter is far likelier to be one trade than the company losing that
 * much of itself in a day — and a real stock that genuinely falls that far will be reported by
 * every feed the page already shows, not just this one.
 */
export function hasMeaningfulChange(status: TradingStatus, price: Pick<PriceView, "liquidityUsd" | "marketChange24hPct"> | null | undefined): boolean {
  if (status !== "tradable") return false;
  const change = price?.marketChange24hPct;
  if (change === null || change === undefined) return false;
  const liq = price?.liquidityUsd ?? 0;
  return liq >= DEEP_USD || Math.abs(change) <= MAX_THIN_MOVE_PCT;
}

/**
 * A batched leg is not the same risk as a hand-placed trade: the user reviews a plan, not each
 * fill, so a leg large enough to move the pool against itself should be caught before they sign
 * anything. Two percent of the pool is the line — at that size the impact is still cents on a deep
 * market, and it is what stops a $20 buy landing in a $108 pool.
 */
export const MAX_LEG_POOL_SHARE = 0.02;

/** What share of the pool this leg would consume; null when there is no pool to measure against. */
export function legPoolShare(targetUsd: number, liquidityUsd: number | null | undefined): number | null {
  if (!liquidityUsd || liquidityUsd <= 0 || !Number.isFinite(targetUsd) || targetUsd <= 0) return null;
  return targetUsd / liquidityUsd;
}

/**
 * Why a buy leg cannot run today, or null when it can. Status first — a stock with no supply, no
 * pool or paused transfers cannot be filled at any size — then size against depth.
 */
export function buyLegBlockedReason(
  status: TradingStatus,
  targetUsd: number,
  liquidityUsd: number | null | undefined,
): string | null {
  if (status === "not-issued") return "not issued on Base yet";
  if (status === "no-pool") return "issued, but no pool can fill it yet";
  if (status === "paused") return "transfers are paused by the issuer";
  const share = legPoolShare(targetUsd, liquidityUsd);
  if (share !== null && share > MAX_LEG_POOL_SHARE) return `this leg is ${(share * 100).toFixed(0)}% of its pool`;
  return null;
}

/**
 * Why a sell leg cannot run today. A sell needs a pool to sell into just as a buy needs one to buy
 * from; a position priced only by the Chainlink reference has nowhere to go.
 */
export function sellLegBlockedReason(status: TradingStatus, targetUsd: number, liquidityUsd: number | null | undefined): string | null {
  if (status === "not-issued") return "no tokens exist to sell";
  if (status === "no-pool") return "no pool can take this sale yet";
  if (status === "paused") return "transfers are paused by the issuer";
  const share = legPoolShare(targetUsd, liquidityUsd);
  if (share !== null && share > MAX_LEG_POOL_SHARE) return `this sale is ${(share * 100).toFixed(0)}% of its pool`;
  return null;
}

/**
 * One answer for every place that batches trades — Build, Rebalance, Automate — so a leg that one
 * screen refuses is refused everywhere, for the same reason, in the same words.
 */
export function legBlockedReason(
  side: "buy" | "sell",
  asset: Pick<B20AssetDTO, "status" | "totalSupply">,
  price: Pick<PriceView, "liquidityUsd" | "volume24hUsd"> | null | undefined,
  targetUsd: number,
): string | null {
  const status = tradingStatus(asset, price).status;
  return side === "buy" ? buyLegBlockedReason(status, targetUsd, price?.liquidityUsd) : sellLegBlockedReason(status, targetUsd, price?.liquidityUsd);
}

/** Below this gap the pool price and the Chainlink reference are the same number for practical purposes. */
export const REFERENCE_GAP_NOTE_PCT = 5;

type ReferencePrice = Pick<PriceView, "deviationPct" | "referenceUsd" | "referenceStale" | "referencePaused"> | null | undefined;

/**
 * How far the pool price sits from the Chainlink reference, when the reference can be trusted.
 * Null when there is no reference, the feed is stale or paused, or the pool has no price.
 */
export function referenceGap(price: ReferencePrice): { pct: number; referenceUsd: number } | null {
  if (!price || price.deviationPct === null || price.deviationPct === undefined) return null;
  if (price.referenceStale || price.referencePaused || !price.referenceUsd || price.referenceUsd <= 0) return null;
  return { pct: price.deviationPct, referenceUsd: price.referenceUsd };
}

/**
 * The gap as a sentence fragment, or null while it is too small to mention. The Trade panel says
 * the same thing at fifteen percent; the batched flows and the assistant say it earlier, because a
 * basket or a plan is reviewed once and then runs on its own.
 */
export function referenceGapNote(price: ReferencePrice, minPct = REFERENCE_GAP_NOTE_PCT): string | null {
  const gap = referenceGap(price);
  if (!gap || Math.abs(gap.pct) < minPct) return null;
  return gap.pct > 0 ? `pool price ${gap.pct.toFixed(0)}% above the stock's own price` : `pool price ${Math.abs(gap.pct).toFixed(0)}% below the stock's own price`;
}

/**
 * Whether an automatic run would refuse this buy leg today: the contract fills no worse than the
 * reference minus the plan's slippage limit, so a premium beyond that limit is skipped every run
 * until the pool comes back. A discount is never a problem for a buy.
 */
export function premiumBeyondFloor(price: ReferencePrice, maxSlippageBps: number): boolean {
  const gap = referenceGap(price);
  return !!gap && gap.pct > maxSlippageBps / 100;
}
