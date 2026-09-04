import type { Address } from "viem";
import { getRepos } from "@/db/repositories";
import { getPortfolioSnapshot } from "@/services/portfolio-service";
import { computeCostBasis, holdingPnl, type HoldingPnl } from "@/lib/portfolio/cost-basis";

/**
 * What a holder has actually made, as far as this app can honestly tell.
 *
 * The ledger is the trades recorded here. It is deliberately not extended with guesses: stock that
 * arrived as a gift, a pool share or an outside transfer has no purchase price anywhere, and the
 * response says how many units are in that state rather than treating them as free profit. A
 * portfolio that is mostly gifts will report a small covered cost and a large uncovered count —
 * which is the truth, and the UI prints it.
 */
export interface HoldingPnlView extends Omit<HoldingPnl, "rawBalance" | "coveredRaw" | "uncoveredRaw"> {
  symbol: string;
  underlying: string;
  decimals: number;
  logoURI?: string;
  rawBalance: string;
  coveredRaw: string;
  uncoveredRaw: string;
  /** Share-equivalent of the uncovered units, for a line the holder can read. */
  uncoveredScaled: string;
}

export interface PortfolioPnl {
  owner: Address;
  /** USD paid for every covered unit still held. */
  costUsd: number;
  /** What those units are worth now. */
  marketUsd: number;
  unrealisedUsd: number;
  unrealisedPct: number | null;
  /** Profit and loss already taken by selling. */
  realisedUsd: number;
  holdings: HoldingPnlView[];
  /** Holdings with units this app cannot price the purchase of. */
  uncoveredHoldings: number;
  /** Trades that went through without a recorded USD value; they are not in the basis. */
  unpricedTrades: number;
  /** True when nothing has ever been bought here — the whole view is empty rather than zero. */
  noTrades: boolean;
  readAt: number;
}

export async function getPortfolioPnl(owner: Address): Promise<PortfolioPnl> {
  const [snapshot, trades] = await Promise.all([
    getPortfolioSnapshot(owner),
    getRepos().trades.listByOwner(owner).catch(() => []),
  ]);
  const basis = computeCostBasis(trades);

  let costUsd = 0;
  let marketUsd = 0;
  let realisedUsd = 0;
  let unpricedTrades = 0;
  let uncoveredHoldings = 0;

  const holdings: HoldingPnlView[] = snapshot.holdings.map((h) => {
    const raw = BigInt(h.rawBalance);
    const p = holdingPnl(h.assetAddress, raw, h.decimals, h.priceUsd, basis.get(h.assetAddress.toLowerCase()));
    costUsd += p.costUsd;
    marketUsd += p.marketUsd;
    realisedUsd += p.realisedUsd;
    unpricedTrades += p.unpricedTrades;
    if (p.uncoveredRaw > 0n) uncoveredHoldings += 1;
    // Share-equivalent for display; the multiplier belongs here and nowhere in the maths above.
    const scaled = raw > 0n ? (p.uncoveredRaw * BigInt(h.scaledBalance)) / raw : 0n;
    return {
      ...p,
      symbol: h.symbol,
      underlying: h.underlying,
      decimals: h.decimals,
      logoURI: h.logoURI,
      rawBalance: raw.toString(),
      coveredRaw: p.coveredRaw.toString(),
      uncoveredRaw: p.uncoveredRaw.toString(),
      uncoveredScaled: scaled.toString(),
    };
  });

  // Realised profit on stock sold down to nothing still counts, even with no holding left to hang
  // it on — otherwise closing a winning position would erase the win from the page.
  for (const [address, b] of basis) {
    if (snapshot.holdings.some((h) => h.assetAddress.toLowerCase() === address)) continue;
    realisedUsd += b.realisedUsd;
    unpricedTrades += b.unpricedTrades;
  }

  const unrealisedUsd = marketUsd - costUsd;
  return {
    owner,
    costUsd,
    marketUsd,
    unrealisedUsd,
    unrealisedPct: costUsd > 0 ? (unrealisedUsd / costUsd) * 100 : null,
    realisedUsd,
    holdings: holdings.sort((a, b) => b.unrealisedUsd - a.unrealisedUsd),
    uncoveredHoldings,
    unpricedTrades,
    noTrades: basis.size === 0,
    readAt: Date.now(),
  };
}
