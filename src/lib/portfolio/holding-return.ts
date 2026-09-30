import { formatUnits } from "viem";
import { equityPricePerShare, multiplierToNumber } from "@/lib/b20/math";

/**
 * One holding's return, per share, for the position card and the shareable return card.
 *
 * Only the units bought through the app have a purchase price (see `holdingPnl`), so everything
 * here is about those: the average cost is what was paid for them, the return is theirs, and
 * `partial` says when the wallet holds more than that. Prices are per share-equivalent, the unit a
 * holder reads on the stock page, so a split or a reinvested dividend (a multiplier change) moves
 * the share count and the per-share price together and leaves the return where it was.
 */
export interface HoldingReturn {
  /** Share-equivalents bought here and still held. */
  coveredShares: number;
  /** USD paid for them. */
  costUsd: number;
  avgCostPerShare: number;
  /** Null when there is no price to compare against right now. */
  pricePerShare: number | null;
  unrealisedUsd: number | null;
  returnPct: number | null;
  /** The wallet holds units with no purchase price behind them (a gift, a pool share, a transfer). */
  partial: boolean;
}

export function holdingReturn(input: {
  /** USD paid for `coveredRaw`. */
  costUsd: number;
  coveredRaw: bigint;
  /** What the wallet holds right now, which can be less than the ledger says after a sale elsewhere. */
  rawBalance: bigint;
  decimals: number;
  multiplierWad: bigint;
  /** Per raw token, like every B20 price in the app. */
  priceUsd: number | null;
}): HoldingReturn | null {
  const { rawBalance, decimals, multiplierWad } = input;
  if (input.coveredRaw <= 0n || rawBalance <= 0n || !(input.costUsd > 0)) return null;
  // Never more covered units than are held; the cost shrinks with them.
  const coveredRaw = input.coveredRaw > rawBalance ? rawBalance : input.coveredRaw;
  const costUsd = input.costUsd * (Number(coveredRaw) / Number(input.coveredRaw));
  const multiplier = multiplierToNumber(multiplierWad);
  const coveredTokens = Number(formatUnits(coveredRaw, decimals));
  const coveredShares = coveredTokens * multiplier;
  if (!(coveredShares > 0)) return null;
  const priced = input.priceUsd !== null && Number.isFinite(input.priceUsd) && input.priceUsd > 0;
  const unrealisedUsd = priced ? coveredTokens * input.priceUsd! - costUsd : null;
  return {
    coveredShares,
    costUsd,
    avgCostPerShare: costUsd / coveredShares,
    pricePerShare: priced ? equityPricePerShare(input.priceUsd!, multiplierWad) : null,
    unrealisedUsd,
    returnPct: unrealisedUsd !== null ? (unrealisedUsd / costUsd) * 100 : null,
    partial: coveredRaw < rawBalance,
  };
}
