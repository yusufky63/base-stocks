import type { Address } from "viem";
import type { B20Asset } from "@/domain/asset";
import type { PriceView, TokenMarketData } from "@/domain/market";
import { getMarketDataProvider } from "@/providers/market-data";
import { readFeeds, isStale } from "@/providers/market-data/chainlink/reader";
import { recallGood, rememberGood } from "@/lib/last-good";
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

/**
 * A token the providers missed this round keeps its last good reading for up to a day.
 *
 * DexScreener and GeckoTerminal miss tokens intermittently (rate limits, partial batches) and
 * sometimes both answer nothing at all for a minute. Without this, a miss nulls `liquidityUsd`
 * and a stock flaps between "Live" and "No pool" on every counter, and a bad minute shows as
 * "0 live markets". The last good reading lives in the shared last-good store, so it survives a
 * cold start too; each entry keeps its own `updatedAt`, so freshness stays honest, and after a
 * day it is dropped rather than shown.
 */
const LAST_GOOD_MAX_AGE_MS = 24 * 3600_000;
const MARKET_KEY = "market:snapshot";

/** Fresh readings first; a token the fresh batch missed takes its last good reading unless that is older than `maxAgeMs`. Pure. */
export function mergeMarketData(addresses: readonly Address[], fresh: Map<string, TokenMarketData>, good: Map<string, TokenMarketData> | null, now: number, maxAgeMs = LAST_GOOD_MAX_AGE_MS): Map<string, TokenMarketData> {
  const out = new Map<string, TokenMarketData>();
  for (const a of addresses) {
    const k = a.toLowerCase();
    const f = fresh.get(k);
    if (f) {
      out.set(k, f);
      continue;
    }
    const kept = good?.get(k);
    if (kept && now - kept.updatedAt <= maxAgeMs) out.set(k, kept);
  }
  return out;
}

/** Market data for many assets; tolerant of provider failure (misses fall back to the last good reading). */
export async function getMarketDataMap(addresses: Address[]): Promise<Map<string, TokenMarketData>> {
  let fresh = new Map<string, TokenMarketData>();
  try {
    fresh = await getMarketDataProvider().getTokenMarkets(addresses);
  } catch (err) {
    metrics.count("market.snapshot", false, err instanceof Error ? err.message : String(err));
  }
  const now = Date.now();
  const good = await recallGood<Map<string, TokenMarketData>>(MARKET_KEY);
  const merged = mergeMarketData(addresses, fresh, good?.value ?? null, now);
  if (merged.size > fresh.size) metrics.count("market.lastgood", true);
  // Remember every token's latest reading: this round's where it answered, the earlier one where it did not.
  if (fresh.size > 0) rememberGood(MARKET_KEY, new Map([...(good?.value ?? new Map<string, TokenMarketData>()), ...fresh]), now);
  return merged;
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
