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

  /**
   * Candles for the token, checked against the price rather than trusted on faith.
   *
   * The pool comes from DexScreener when it priced the token, which costs nothing extra: that call
   * already happened. GeckoTerminal's own lookup is the fallback, and it is a fallback rather than
   * the default because every GeckoTerminal call waits behind a 2.2 second gate on the keyless
   * tier, shared with pool discovery. Asking it twice per chart, once for the pool and once for the
   * candles, is what made every chart in the app fall back to the reference series for a while.
   *
   * That leaves the orientation, which used to be assumed and was wrong: DexScreener and
   * GeckoTerminal each order a pair by their own rule, and when they disagreed the chart plotted the
   * far side. TSLAc drew at $0.00023 under a header reading $17,936.
   *
   * So rather than pay a call to learn the orientation, the series is validated against the price
   * that already passed its own reference check. A series that disagrees with it is not this token's
   * series, whichever way it got that way, and returning nothing hands the chart to Chainlink round
   * history, which Base documents as a first-class source for exactly this.
   */
  async getTokenOhlcv(address: Address, timeframe: Timeframe, hint?: TokenMarketData | null): Promise<Candle[]> {
    // The caller's reading first (the batch snapshot the page already holds); a fetch only when none is known.
    const market = hint ?? (await this.getTokenMarket(address).catch(() => null));
    let pool: Address | undefined = market?.source === "dexscreener" ? market.primaryPool : undefined;
    let tokenIsBase = true;
    if (!pool) {
      const gtPool = await getGeckoTerminalPrimaryPool(address);
      if (!gtPool) return [];
      pool = gtPool.pool;
      tokenIsBase = gtPool.tokenIsBase;
    }

    const candles = await getGeckoTerminalOhlcv(pool, tokenIsBase, timeframe);
    const expected = market?.priceUsd ?? null;
    if (candles.length === 0 || expected === null || expected <= 0) return candles;

    const last = candles[candles.length - 1]?.close ?? 0;
    // A quarter is loose on purpose: the last candle can be hours old while the price is live, and
    // this is here to catch a series in the wrong units, not to police a real move.
    if (!(last > 0) || Math.abs(last - expected) / expected > 0.25) {
      metrics.count("keyless.ohlcv.rejected", false, `${address}: last ${last} vs price ${expected}`);
      return [];
    }
    return candles;
  }
}

export const keylessProvider = new KeylessMarketDataProvider();
