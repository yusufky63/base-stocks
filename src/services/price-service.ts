import type { Address } from "viem";
import type { B20Asset } from "@/domain/asset";
import type { PriceView, TokenMarketData } from "@/domain/market";
import { getMarketDataProvider } from "@/providers/market-data";
import { readFeeds, isStale } from "@/providers/market-data/chainlink/reader";
import { cached, TTL } from "@/lib/cache";
import { metrics } from "@/lib/http";
import { serverEnv } from "@/config/env";

/** Chainlink ETH / USD on Base mainnet (verified via description()). Used only for fee display. */
export const ETH_USD_FEED: Address = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";

/**
 * Three distinct price concepts (spec §11):
 *   REFERENCE = Chainlink (total-return, per raw token)
 *   MARKET    = market-data provider (DEX, per raw token)
 *   EXECUTABLE= 0x / Kyber quote (computed in trade-router)
 * Never collapsed into one field.
 */
export function buildPriceView(asset: B20Asset, market: TokenMarketData | null): PriceView {
  const referenceUsd = asset.oracle?.priceUsd ?? null;
  const referenceUsable = referenceUsd !== null && asset.oracle !== undefined && !asset.oracle.paused && !asset.oracle.stale;
  const marketUsd = market?.priceUsd ?? null;

  const deviationPct = marketUsd !== null && referenceUsd !== null && referenceUsd > 0 ? ((marketUsd - referenceUsd) / referenceUsd) * 100 : null;

  // Trust gate for the display price: a "market" price read off a dust pool (a few dollars of
  // liquidity, 2-25x away from a usable reference) is noise, not a market. Keep marketUsd itself
  // for transparency, but display the reference until real liquidity shows up.
  const marketTrusted =
    marketUsd !== null &&
    (!referenceUsable ||
      (market?.liquidityUsd ?? 0) >= 20_000 ||
      deviationPct === null ||
      Math.abs(deviationPct) <= 20);

  let displayUsd: number | null = null;
  let displaySource: PriceView["displaySource"] = "none";
  if (marketUsd !== null && marketTrusted) {
    displayUsd = marketUsd;
    displaySource = "market";
  } else if (referenceUsd !== null) {
    displayUsd = referenceUsd;
    displaySource = "reference";
  } else if (marketUsd !== null) {
    displayUsd = marketUsd;
    displaySource = "market";
  }

  return {
    address: asset.address,
    marketUsd,
    marketChange24hPct: market?.change24hPct ?? null,
    marketUpdatedAt: market?.updatedAt ?? null,
    liquidityUsd: market?.liquidityUsd ?? null,
    volume24hUsd: market?.volume24hUsd ?? null,
    referenceFreshness: asset.oracle?.freshness ?? "stale",
    referenceUsd,
    referenceStale: asset.oracle?.stale ?? true,
    referencePaused: asset.oracle?.paused ?? false,
    referenceUpdatedAt: asset.oracle ? Number(asset.oracle.updatedAt) * 1000 : null,
    displayUsd,
    displaySource,
    deviationPct: referenceUsable ? deviationPct : deviationPct,
  };
}

/** Market data for many assets; tolerant of provider failure (returns empty map). */
export async function getMarketDataMap(addresses: Address[]): Promise<Map<string, TokenMarketData>> {
  try {
    return await getMarketDataProvider().getTokenMarkets(addresses);
  } catch (err) {
    metrics.count("market.snapshot", false, err instanceof Error ? err.message : String(err));
    return new Map();
  }
}

export async function getPriceViews(assets: B20Asset[]): Promise<Map<string, PriceView>> {
  const md = await getMarketDataMap(assets.map((a) => a.address));
  const out = new Map<string, PriceView>();
  for (const a of assets) out.set(a.canonicalId, buildPriceView(a, md.get(a.canonicalId) ?? null));
  return out;
}

/** ETH/USD for network-fee display. Null when unavailable; never blocks trading. */
export async function getEthUsd(): Promise<number | null> {
  return cached("eth-usd", TTL.oracle, async () => {
    const m = await readFeeds([ETH_USD_FEED]);
    const r = m.get(ETH_USD_FEED.toLowerCase());
    if (!r) return null;
    if (isStale(r.updatedAt, serverEnv().ORACLE_STALENESS_SECONDS * 24)) return null;
    return Number(r.answer) / 10 ** r.decimals;
  });
}

/** Basis for price-impact display: fresh reference first, else market. */
export function impactBasis(view: PriceView): { price: number; basis: "reference" | "market" } | null {
  if (view.referenceUsd !== null && !view.referenceStale && !view.referencePaused) return { price: view.referenceUsd, basis: "reference" };
  if (view.marketUsd !== null) return { price: view.marketUsd, basis: "market" };
  if (view.referenceUsd !== null) return { price: view.referenceUsd, basis: "reference" };
  return null;
}
