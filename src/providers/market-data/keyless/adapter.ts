import type { Address } from "viem";
import type { Candle, MarketDataProvider, Timeframe, TokenMarketData, TokenMetadata } from "@/domain/market";
import { cached, TTL } from "@/lib/cache";
import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";
import { getDexScreenerMarkets, getDexScreenerLogo } from "../dexscreener/adapter";
import { getGeckoTerminalMetadata, getGeckoTerminalOhlcv, getGeckoTerminalPrices, getGeckoTerminalPrimaryPool } from "../geckoterminal/adapter";
import { getDexPools } from "@/providers/earn/geckoterminal-pools";

/**
 * Keyless market data (default): DexScreener for shared price snapshots (price, 24h change,
 * volume, liquidity, primary pair), GeckoTerminal for OHLCV and metadata, with GeckoTerminal
 * as the price fallback. Everything is cached in-process with stale-while-revalidate, so a
 * burst of visitors costs one upstream request per window — never one per user.
 */
/**
 * GeckoTerminal's liquidity, restated the way DexScreener states it.
 *
 * `total_reserve_in_usd` counts only the token's own side of each pool; DexScreener's
 * `liquidity.usd` counts both. Adding one to the other produced a headline liquidity figure that
 * moved by a factor of two depending on which provider happened to answer for which stock that
 * minute — the same NVDAc read as $3.8M from one and $1.5M from the other. The pools carry
 * `reserve_in_usd`, which is both sides, so the figure is summed from those instead and the total
 * is one definition throughout.
 */
async function comparableLiquidity(asset: Address): Promise<number | null> {
  const pools = await getDexPools(asset, { includeUnknown: true }).catch(() => []);
  if (pools.length === 0) return null;
  return pools.reduce((sum, p) => sum + p.reserveUsd, 0);
}

export class KeylessMarketDataProvider implements MarketDataProvider {
  readonly id = "keyless";

  async getTokenMarkets(addresses: Address[]): Promise<Map<string, TokenMarketData>> {
    if (addresses.length === 0) return new Map();
    const key = `keyless:prices:${addresses.map((a) => a.toLowerCase()).sort().join(",")}`;
    const rows = await cached(key, TTL.market, async (): Promise<Array<[string, TokenMarketData]>> => {
      const rows = new Map<string, TokenMarketData>();
      try {
        for (const [k, v] of await getDexScreenerMarkets(addresses)) if (v.priceUsd !== null) rows.set(k, v);
      } catch (err) {
        metrics.count("keyless.prices.fallback", false, err instanceof Error ? err.message : String(err));
      }
      // Fill anything DexScreener did not cover from GeckoTerminal (no 24h change there).
      const missing = addresses.filter((a) => !rows.has(a.toLowerCase()));
      if (missing.length > 0) {
        try {
          const gt = await getGeckoTerminalPrices(missing);
          const now = Date.now();
          for (const a of missing) {
            const v = gt.get(a.toLowerCase());
            if (!v || v.priceUsd === null) continue;
            rows.set(a.toLowerCase(), { address: a, priceUsd: v.priceUsd, change24hPct: null, volume24hUsd: v.volume24hUsd, liquidityUsd: await comparableLiquidity(a), marketCapUsd: v.marketCapUsd, source: "geckoterminal", updatedAt: now, primaryPool: v.primaryPool });
          }
        } catch (err) {
          metrics.count("keyless.prices.gt", false, err instanceof Error ? err.message : String(err));
        }
      }
      // Nothing from either provider is an outage, not a market with no pools: refusing here keeps
      // the previous good value in the cache instead of replacing it with an empty one for a window.
      if (rows.size === 0) throw new AppError("PROVIDER_UNAVAILABLE", "keyless: no market data from any provider", 503);
      return [...rows.entries()];
    });
    return new Map(rows);
  }

  async getTokenMarket(address: Address): Promise<TokenMarketData | null> {
    const m = await this.getTokenMarkets([address]);
    return m.get(address.toLowerCase()) ?? null;
  }

  async getTokenMetadata(address: Address): Promise<TokenMetadata | null> {
    const meta = await getGeckoTerminalMetadata(address);
    if (meta?.logoURI) return meta;
    const logo = await getDexScreenerLogo(address);
    return logo ? { address, logoURI: logo, ...meta } : meta;
  }

  async getTokenOhlcv(address: Address, timeframe: Timeframe): Promise<Candle[]> {
    // Prefer the DexScreener primary pair (token is the base asset there by construction).
    const market = await this.getTokenMarket(address).catch(() => null);
    let pool: Address | undefined = market?.source === "dexscreener" ? market.primaryPool : undefined;
    let tokenIsBase = true;
    if (!pool) {
      const gtPool = await getGeckoTerminalPrimaryPool(address);
      if (!gtPool) return [];
      pool = gtPool.pool;
      tokenIsBase = gtPool.tokenIsBase;
    }
    return getGeckoTerminalOhlcv(pool, tokenIsBase, timeframe);
  }
}

export const keylessProvider = new KeylessMarketDataProvider();
