import type { B20Asset } from "@/domain/asset";
import type { TokenMarketData } from "@/domain/market";
import { recallGood, rememberGood } from "@/lib/last-good";
import { getAssets } from "./b20-asset-service";
import { getMarketDataMap } from "./price-service";
import { LISTING_MARKET_MAX_AGE_MS, MIN_LISTING_LIQUIDITY_USD, filterWithConcurrency, hasTwoWayStockRoute, marketListingBlockedReason } from "./asset-tradability-service";

/**
 * How long a stock stays listed after its last confirmed check while the next one cannot be
 * completed. A provider that misses a token, a market snapshot served from the last-good store or
 * a route probe that times out says nothing about the stock; without this window each of them
 * removed it from Markets for the visitor who happened to ask during the bad minute.
 */
export const CATALOG_GRACE_MS = 30 * 60_000;
/**
 * A page render waits this long for the route probe of a stock with no confirmation inside the
 * grace window; the probe itself keeps running and fills the cache. A buy and then a sell quote
 * through hedged providers can outrun 4 seconds on a cold cache: at 4 s the first list after a
 * quiet spell held 28 of 36 live stocks (2026-10-04).
 */
const PROBE_BUDGET_MS = 10_000;
/**
 * A stock confirmed inside the grace window stays listed while its next probe runs, so for it the
 * render only takes an answer the cache already holds and lets the providers finish in the background.
 */
const CONFIRMED_PROBE_WAIT_MS = 250;
/** Confirmation times are rewritten at most this often, so a busy minute is not a write per request. */
const CONFIRM_REFRESH_MS = 5 * 60_000;
const CONFIRMED_KEY = "stock:catalog:confirmed";

type Verdict = "confirmed" | "rejected" | "unknown";

/** A fresh reading that shows a pool below the listing minimum is evidence; anything else missing is not. */
function hasFreshDustPool(market: TokenMarketData | null | undefined, now: number): boolean {
  if (!market || !Number.isFinite(market.updatedAt) || market.updatedAt > now || now - market.updatedAt > LISTING_MARKET_MAX_AGE_MS) return false;
  return typeof market.liquidityUsd === "number" && Number.isFinite(market.liquidityUsd) && market.liquidityUsd < MIN_LISTING_LIQUIDITY_USD;
}

async function probeWithinBudget(asset: B20Asset, budgetMs: number): Promise<boolean | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  try {
    return await Promise.race([hasTwoWayStockRoute(asset.address, asset.decimals).catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface AssetCatalog {
  /** Every verified stock in the identity registry: what holdings, history, baskets and orders are looked up in. */
  assets: B20Asset[];
  /** Canonical ids of the ones that can be traded right now: what Markets and the public stock list show. */
  listed: Set<string>;
}

/** The registry and the trading catalog in one read, for responses that need both. */
export async function getAssetCatalog(): Promise<AssetCatalog> {
  const all = await getAssets();
  const listed = await selectTradable(all);
  return { assets: all, listed: new Set(listed.map((a) => a.canonicalId)) };
}

/** The trading catalog is separate from the identity registry used for wallet holdings/history. */
export async function getTradableAssets(): Promise<B20Asset[]> {
  return selectTradable(await getAssets());
}

async function selectTradable(all: B20Asset[]): Promise<B20Asset[]> {
  // Onchain state is never bridged by the grace window: unissued, paused or unverified is out at once.
  const assets = all.filter((a) => a.verification === "verified" && a.status === "active" && a.supplyKnown && a.totalSupply > 0n && !a.transferPaused);
  const [markets, remembered] = await Promise.all([
    getMarketDataMap(assets.map((a) => a.address)).catch(() => new Map<string, TokenMarketData>()),
    recallGood<Map<string, number>>(CONFIRMED_KEY).catch(() => null),
  ]);
  const now = Date.now();
  const previous = remembered?.value ?? new Map<string, number>();
  const verdicts = new Map<string, Verdict>();
  await filterWithConcurrency(assets, async (asset) => {
    const market = markets.get(asset.canonicalId);
    const last = previous.get(asset.canonicalId);
    const budgetMs = last !== undefined && now - last <= CATALOG_GRACE_MS ? CONFIRMED_PROBE_WAIT_MS : PROBE_BUDGET_MS;
    let verdict: Verdict = "unknown";
    if (hasFreshDustPool(market, now)) verdict = "rejected";
    else if (!marketListingBlockedReason(market, now) && (await probeWithinBudget(asset, budgetMs)) === true) verdict = "confirmed";
    verdicts.set(asset.canonicalId, verdict);
    return true;
  });

  const next = new Map<string, number>();
  let changed = false;
  const listed = assets.filter((asset) => {
    const verdict = verdicts.get(asset.canonicalId);
    const last = previous.get(asset.canonicalId);
    if (verdict === "confirmed") {
      const keep = last !== undefined && now - last < CONFIRM_REFRESH_MS;
      next.set(asset.canonicalId, keep ? last : now);
      if (!keep) changed = true;
      return true;
    }
    if (verdict === "unknown" && last !== undefined && now - last <= CATALOG_GRACE_MS) {
      next.set(asset.canonicalId, last);
      return true;
    }
    if (last !== undefined) changed = true;
    return false;
  });
  if (changed || next.size !== previous.size) rememberGood(CONFIRMED_KEY, next, now);
  return listed;
}
