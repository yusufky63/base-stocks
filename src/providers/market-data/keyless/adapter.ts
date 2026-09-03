import type { Address } from "viem";
import type { Candle, MarketDataProvider, Timeframe, TokenMarketData, TokenMetadata } from "@/domain/market";
import { cached, TTL } from "@/lib/cache";
import { metrics } from "@/lib/http";
import { getDexScreenerMarkets, getDexScreenerLogo } from "../dexscreener/adapter";
import { getGeckoTerminalMetadata, getGeckoTerminalOhlcv, getGeckoTerminalPrices, getGeckoTerminalPrimaryPool } from "../geckoterminal/adapter";

/**
 * Keyless market data (default): DexScreener for shared price snapshots (price, 24h change,
 * volume, liquidity, primary pair), GeckoTerminal for OHLCV and metadata, with GeckoTerminal
 * as the price fallback. Everything is cached in-process with stale-while-revalidate, so a
 * burst of visitors costs one upstream request per window — never one per user.
 */
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
            rows.set(a.toLowerCase(), { address: a, priceUsd: v.priceUsd, change24hPct: null, volume24hUsd: v.volume24hUsd, liquidityUsd: v.liquidityUsd, marketCapUsd: v.marketCapUsd, source: "geckoterminal", updatedAt: now, primaryPool: v.primaryPool });
          }
        } catch (err) {
          metrics.count("keyless.prices.gt", false, err instanceof Error ? err.message : String(err));
        }
      }
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
