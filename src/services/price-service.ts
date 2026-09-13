import { formatUnits, type Address } from "viem";
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
/**
 * How far a pool price may sit from the reference and still be the headline number.
 *
 * Only consulted while the feed is live, so this is a market-hours tolerance rather than a weekend
 * one. Twenty percent is wide for an equity and deliberately so: it is here to catch a broken
 * price, not to second-guess a real move.
 */
const MAX_DISPLAY_DEVIATION_PCT = 20;

/** Below this, a pool is a quote somebody left lying around rather than a market. */
const MIN_DISPLAY_LIQUIDITY_USD = 20_000;

export function buildPriceView(asset: B20Asset, market: TokenMarketData | null): PriceView {
  const referenceUsd = asset.oracle?.priceUsd ?? null;
  const referenceUsable = referenceUsd !== null && asset.oracle !== undefined && !asset.oracle.paused && !asset.oracle.stale;
  const marketUsd = market?.priceUsd ?? null;

  const deviationPct = marketUsd !== null && referenceUsd !== null && referenceUsd > 0 ? ((marketUsd - referenceUsd) / referenceUsd) * 100 : null;

  /**
   * Trust gate for the display price.
   *
   * Base's own guidance is the reason this exists and the reason it is shaped this way: the
   * Chainlink feed is sourced from traditional equity market data and "the token's DEX price does
   * not feed the oracle", so the reference is the one number nobody can move by opening a pool. A
   * market price earns the headline only by agreeing with it.
   *
   * This used to be a chain of `||`, which meant deep liquidity alone satisfied the gate and the
   * deviation was never consulted. TSLAc passed it at 48.97x out because the pool behind that price
   * held $717k. Depth and correctness are different properties; the deviation check is now
   * mandatory whenever there is a usable reference to check against.
   *
   * When the reference is not usable there is nothing to check against, and refusing the market
   * price would leave the page blank. Off-hours that is the normal state: the feed publishes 24/5
   * and holds its last value on nights, weekends and corporate actions, while the DEX keeps
   * trading. So the check applies exactly when it can mean something.
   */
  const marketTrusted =
    marketUsd !== null &&
    (!referenceUsable ||
      (deviationPct !== null && Math.abs(deviationPct) <= MAX_DISPLAY_DEVIATION_PCT && (market?.liquidityUsd ?? 0) >= MIN_DISPLAY_LIQUIDITY_USD));

  // Why the pool price lost the headline, for the page to say so in the right words. Depth first:
  // a thin pool's deviation is expected, and "deviation" would blame the wrong thing.
  let displayReason: PriceView["displayReason"] = null;
  if (marketUsd !== null && !marketTrusted) displayReason = (market?.liquidityUsd ?? 0) < MIN_DISPLAY_LIQUIDITY_USD ? "thin" : "deviation";

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
    deviationPct,
    displayReason,
    marketCapUsd: market?.marketCapUsd ?? null,
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

/**
 * The latest reading for one token without a provider call: whatever the last batch remembered,
 * if it is younger than the market cache's full window. The chart uses it to validate its candles;
 * before this, every chart asked DexScreener again for a number the page had just fetched.
 */
export async function peekMarketData(address: Address, maxAgeMs = TTL.market.ttlMs + TTL.market.staleMs): Promise<TokenMarketData | null> {
  const good = await recallGood<Map<string, TokenMarketData>>(MARKET_KEY).catch(() => null);
  const v = good?.value?.get(address.toLowerCase());
  return v && Date.now() - v.updatedAt <= maxAgeMs ? v : null;
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
/**
 * What `rawAmount` of a stock is worth right now, at the same basis the trade panel measures
 * impact against; null when neither a live reference nor a trusted market price is known.
 */
export async function estimateStockUsd(asset: B20Asset, rawAmount: bigint): Promise<number | null> {
  if (rawAmount <= 0n) return null;
  const md = await getMarketDataMap([asset.address]).catch(() => new Map<string, TokenMarketData>());
  const view = buildPriceView(asset, md.get(asset.canonicalId) ?? null);
  const price = impactBasis(view)?.price ?? view.displayUsd ?? asset.oracle?.priceUsd ?? null;
  if (price === null || !(price > 0)) return null;
  return Number(formatUnits(rawAmount, asset.decimals)) * price;
}

export function impactBasis(view: PriceView): { price: number; basis: "reference" | "market" } | null {
  if (view.referenceUsd !== null && !view.referenceStale && !view.referencePaused) return { price: view.referenceUsd, basis: "reference" };
  if (view.marketUsd !== null) return { price: view.marketUsd, basis: "market" };
  if (view.referenceUsd !== null) return { price: view.referenceUsd, basis: "reference" };
  return null;
}
