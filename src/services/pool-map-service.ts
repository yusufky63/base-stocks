import type { Address } from "viem";
import { getDexPools } from "@/providers/earn/geckoterminal-pools";
import { getMarketDataMap } from "./price-service";
import { getAssets } from "./b20-asset-service";
import { discoverEarn } from "./earn-opportunity-service";
import { AppError } from "@/lib/errors";

export interface PoolRow {
  address: Address;
  name: string;
  dexId: string;
  dexLabel: string;
  /** DEX the app can name (Uniswap v3/v4, Aerodrome v2/Slipstream); unknown venues are listed but not linked. */
  known: boolean;
  reserveUsd: number;
  volume24hUsd: number | null;
  /** The pool prices and charts are read from. */
  primary: boolean;
  /** Aggregators (KyberSwap, Velora, Uniswap API) route through it. */
  routes: boolean;
  /** Positions in it show up under Earn → Liquidity positions and on the stock page. */
  lpTracked: boolean;
  /** Listed as a venue on the stock's Earn or borrow tab. */
  inEarn: boolean;
  url: string | null;
}

export interface PoolMapView {
  asset: Address;
  primaryPool: Address | null;
  pools: PoolRow[];
  totals: { count: number; known: number; liquidityUsd: number; volume24hUsd: number };
  updatedAt: number;
}

/**
 * Every DEX pool GeckoTerminal reports for a stock, compared with what the app itself does with it:
 * which one feeds prices, which ones aggregators route through, which ones LP tracking covers and
 * which appear on the Earn tab. Makes "we show 8 pools, GeckoTerminal shows 9" a visible fact.
 */
export async function getPoolMap(address: Address): Promise<PoolMapView> {
  const assets = await getAssets();
  const asset = assets.find((a) => a.canonicalId === address.toLowerCase());
  if (!asset) throw new AppError("NOT_FOUND", "Unknown asset", 404);
  const [pools, md, earn] = await Promise.all([getDexPools(asset.address, { includeUnknown: true }), getMarketDataMap([asset.address]).catch(() => new Map()), discoverEarn(asset.address).catch(() => null)]);
  const primary = md.get(asset.canonicalId)?.primaryPool?.toLowerCase() ?? null;
  const earnPools = new Set((earn?.opportunities ?? []).map((o) => String(o.metadata.pool ?? "").toLowerCase()).filter(Boolean));
  const rows: PoolRow[] = pools.map((p) => ({
    address: p.address,
    name: p.name,
    dexId: p.dexId,
    dexLabel: p.dexLabel,
    known: p.provider !== null,
    reserveUsd: p.reserveUsd,
    volume24hUsd: p.volume24hUsd,
    primary: p.address.toLowerCase() === primary,
    routes: p.provider !== null,
    lpTracked: /^(uniswap-v3|aerodrome-slipstream)/i.test(p.dexId),
    inEarn: earnPools.has(p.address.toLowerCase()),
    url: p.url,
  }));
  return {
    asset: asset.address,
    primaryPool: (primary as Address | null) ?? null,
    pools: rows,
    totals: { count: rows.length, known: rows.filter((r) => r.known).length, liquidityUsd: rows.reduce((s, r) => s + r.reserveUsd, 0), volume24hUsd: rows.reduce((s, r) => s + (r.volume24hUsd ?? 0), 0) },
    updatedAt: Date.now(),
  };
}
