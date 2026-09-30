import type { Address } from "viem";
import { getRepos } from "@/db/repositories";
import { getPortfolioSnapshot } from "@/services/portfolio-service";
import { getAsset, getBalances } from "@/services/b20-asset-service";
import { getPriceViews } from "@/services/price-service";
import { computeCostBasis, holdingPnl, type HoldingPnl } from "@/lib/portfolio/cost-basis";
import { holdingReturn } from "@/lib/portfolio/holding-return";
import { findCuratedAsset } from "@/lib/b20/registry";
import { cached } from "@/lib/cache";

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

/** Enough for years of daily plans; the repository pages underneath. */
const COST_BASIS_ROWS = 20_000;

export async function getPortfolioPnl(owner: Address): Promise<PortfolioPnl> {
  const [snapshot, trades] = await Promise.all([
    getPortfolioSnapshot(owner),
    // The whole ledger, not the history page: a basis built from the newest 200 rows loses the
    // oldest buys first and reads every later sell as a sale of nothing.
    getRepos().trades.listByOwner(owner, COST_BASIS_ROWS).catch(() => []),
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

/**
 * A return somebody chose to share: one stock, as a percentage and per share. The card and its page
 * show no dollar amounts, share counts or address, since a card travels far beyond the person who
 * posted it. Computed here from the trades this app recorded and the wallet's balance on Base,
 * never from numbers in the link, so a card cannot claim a return that did not happen.
 */
export interface SharedReturn {
  assetAddress: Address;
  underlying: string;
  name: string;
  logoURI?: string;
  returnPct: number;
  avgCostPerShare: number;
  pricePerShare: number;
  /** The wallet also holds units with no purchase price; the return covers the rest. */
  partial: boolean;
  readAt: number;
}

/** A share card is a snapshot; five minutes keeps a burst of link previews to one computation. */
const SHARED_RETURN_CACHE = { ttlMs: 5 * 60_000, staleMs: 30 * 60_000, shared: true };

export async function getSharedReturn(owner: Address, assetAddress: string): Promise<SharedReturn | null> {
  const entry = findCuratedAsset(assetAddress);
  if (!entry) return null;
  return cached(`pnl:share:${owner.toLowerCase()}:${entry.address.toLowerCase()}`, SHARED_RETURN_CACHE, async (): Promise<SharedReturn | null> => {
    const trades = await getRepos().trades.listByOwner(owner, COST_BASIS_ROWS).catch(() => []);
    const basis = computeCostBasis(trades).get(entry.address.toLowerCase());
    // Nothing bought here: answered from the database alone, with no chain read for a made-up link.
    if (!basis || basis.coveredRaw <= 0n) return null;
    const asset = await getAsset(entry.address);
    if (!asset) return null;
    const [[balance], prices] = await Promise.all([getBalances(owner, [asset]), getPriceViews([asset])]);
    const rawBalance = balance?.rawBalance ?? 0n;
    const priceUsd = prices.get(asset.canonicalId)?.displayUsd ?? null;
    const p = holdingPnl(asset.address, rawBalance, asset.decimals, priceUsd, basis);
    const r = holdingReturn({ costUsd: p.costUsd, coveredRaw: p.coveredRaw, rawBalance, decimals: asset.decimals, multiplierWad: asset.multiplier, priceUsd });
    if (!r || r.returnPct === null || r.pricePerShare === null) return null;
    return {
      assetAddress: asset.address,
      underlying: asset.underlying,
      name: asset.name,
      logoURI: asset.logoURI,
      returnPct: r.returnPct,
      avgCostPerShare: r.avgCostPerShare,
      pricePerShare: r.pricePerShare,
      partial: r.partial,
      readAt: Date.now(),
    };
  });
}
