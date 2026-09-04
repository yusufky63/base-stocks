import type { TradeRecord } from "@/db/repositories";

/**
 * Average-cost basis from the trades this app recorded.
 *
 * Average cost, not FIFO: without per-lot tracking FIFO would be a guess dressed as precision, and
 * average cost is what a holder reading "you are up $12" actually means.
 *
 * Two limits are structural and the UI has to say them out loud rather than paper over them:
 *
 * - **Only trades made here are known.** Stock that arrived as a gift, as a pool share, or from a
 *   wallet transfer has no purchase behind it in this database. Those units are reported as
 *   uncovered, never as free.
 * - **A trade with no recorded USD value is not guessed at.** `sellAmount` is denominated in
 *   whatever was paid — USDC on the default path, native ETH on another — and a wrong basis is
 *   worse than a missing one. Such trades are counted and surfaced, not silently averaged in.
 *
 * Amounts are raw token units throughout, which is the right unit for B20: `balanceOf` does not
 * rebase, so a raw unit bought last month is the same raw unit today. Only the share-equivalent
 * view moves with the multiplier, and that is a display concern.
 */
export interface AssetCostBasis {
  /** Lowercased asset address. */
  assetAddress: string;
  /** Raw units still held out of everything bought here (sells removed at average cost). */
  coveredRaw: bigint;
  /** USD paid for exactly those units. */
  costUsd: number;
  /** Profit or loss already taken by selling, in USD. */
  realisedUsd: number;
  buys: number;
  sells: number;
  /** Trades skipped because no USD value was recorded; their units are not in `coveredRaw`. */
  unpricedTrades: number;
}

const empty = (assetAddress: string): AssetCostBasis => ({
  assetAddress,
  coveredRaw: 0n,
  costUsd: 0,
  realisedUsd: 0,
  buys: 0,
  sells: 0,
  unpricedTrades: 0,
});

/** A trade only counts once it has actually been sent; drafts and failures never happened. */
function counts(t: TradeRecord): boolean {
  return !!t.txHash && t.status !== "failed";
}

/**
 * Walks a wallet's trades oldest-first and returns the position it built per asset.
 * Order matters: a sell can only realise against what was bought before it.
 */
export function computeCostBasis(trades: TradeRecord[]): Map<string, AssetCostBasis> {
  const out = new Map<string, AssetCostBasis>();
  const ordered = [...trades].filter(counts).sort((a, b) => a.createdAt - b.createdAt);

  for (const t of ordered) {
    const key = t.assetAddress.toLowerCase();
    const pos = out.get(key) ?? empty(key);
    out.set(key, pos);

    const usd = t.usdValue;
    if (usd === null || usd === undefined || !Number.isFinite(usd) || usd <= 0) {
      pos.unpricedTrades += 1;
      continue;
    }

    if (t.side === "buy") {
      const units = BigInt(t.buyAmount);
      if (units <= 0n) continue;
      pos.coveredRaw += units;
      pos.costUsd += usd;
      pos.buys += 1;
      continue;
    }

    // Sell: realise against the average cost of what is covered, and never below zero units.
    const asked = BigInt(t.sellAmount);
    if (asked <= 0n) continue;
    pos.sells += 1;
    if (pos.coveredRaw === 0n) {
      // Selling units this app never saw bought — the proceeds are real, the basis is unknown, so
      // no gain is invented. The uncovered figure on the holding already tells that story.
      continue;
    }
    const sold = asked > pos.coveredRaw ? pos.coveredRaw : asked;
    const share = Number(sold) / Number(pos.coveredRaw);
    const basisOut = pos.costUsd * share;
    const proceeds = asked > 0n ? usd * (Number(sold) / Number(asked)) : usd;
    pos.realisedUsd += proceeds - basisOut;
    pos.costUsd -= basisOut;
    pos.coveredRaw -= sold;
    if (pos.coveredRaw === 0n) pos.costUsd = 0; // no units left, no basis left
  }

  return out;
}

export interface HoldingPnl {
  assetAddress: string;
  /** Raw units the wallet holds right now. */
  rawBalance: bigint;
  /** Of those, how many have a purchase price behind them. */
  coveredRaw: bigint;
  /** Units with no recorded purchase: gifts, pool shares, transfers, unpriced trades. */
  uncoveredRaw: bigint;
  /** USD paid for the covered units. */
  costUsd: number;
  /** What those same covered units are worth now. */
  marketUsd: number;
  unrealisedUsd: number;
  unrealisedPct: number | null;
  realisedUsd: number;
  unpricedTrades: number;
}

/**
 * Values a holding against its basis. `priceUsd` is per whole token, the same unit the rest of the
 * app prices B20 in (`rawValueUsd`), so `decimals` is needed to turn raw units into it. No
 * multiplier maths belongs here: the multiplier is a share-equivalent view, and a raw unit bought
 * last month is the same raw unit today.
 *
 * Only the covered units are compared. A wallet holding 10 units with 4 bought here is up or down
 * on those 4; claiming a gain on the other 6 would be inventing a purchase that never happened.
 */
export function holdingPnl(
  assetAddress: string,
  rawBalance: bigint,
  decimals: number,
  priceUsd: number | null,
  basis: AssetCostBasis | undefined,
): HoldingPnl {
  const b = basis ?? empty(assetAddress.toLowerCase());
  // Never claim more covered units than are actually held: selling elsewhere, or sending stock
  // away, leaves the ledger ahead of the wallet.
  const coveredRaw = b.coveredRaw > rawBalance ? rawBalance : b.coveredRaw;
  const scale = b.coveredRaw > 0n ? Number(coveredRaw) / Number(b.coveredRaw) : 0;
  const costUsd = b.costUsd * scale;
  const priced = priceUsd !== null && Number.isFinite(priceUsd);
  const marketUsd = priced ? (Number(coveredRaw) / 10 ** decimals) * priceUsd! : 0;
  const unrealisedUsd = priced ? marketUsd - costUsd : 0;
  return {
    assetAddress: assetAddress.toLowerCase(),
    rawBalance,
    coveredRaw,
    uncoveredRaw: rawBalance > coveredRaw ? rawBalance - coveredRaw : 0n,
    costUsd,
    marketUsd,
    unrealisedUsd,
    unrealisedPct: priced && costUsd > 0 ? (unrealisedUsd / costUsd) * 100 : null,
    realisedUsd: b.realisedUsd,
    unpricedTrades: b.unpricedTrades,
  };
}
