import type { Address } from "viem";
import type { MarketDataProvider, Timeframe, TokenMarketData } from "@/domain/market";
import { serverEnv } from "@/config/env";
import { coinGeckoProvider } from "./coingecko/adapter";
import { keylessProvider } from "./keyless/adapter";

/** DexScreener → GeckoTerminal, plus CoinGecko for missing tokens when configured. */
const fallbackProvider: MarketDataProvider = {
  id: "dex-fallback",
  async getTokenMarkets(addresses: Address[]) {
    const rows = await keylessProvider.getTokenMarkets(addresses).catch(() => new Map<string, TokenMarketData>());
    const missing = addresses.filter((a) => !rows.get(a.toLowerCase())?.priceUsd);
    if (missing.length) {
      const fallback = await coinGeckoProvider.getTokenMarkets(missing).catch(() => new Map<string, TokenMarketData>());
      for (const [key, market] of fallback) if (market.priceUsd !== null && market.priceUsd > 0) rows.set(key, market);
    }
    return rows;
  },
  async getTokenMarket(address: Address) {
    return (await this.getTokenMarkets([address])).get(address.toLowerCase()) ?? null;
  },
  async getTokenMetadata(address: Address) {
    const meta = await keylessProvider.getTokenMetadata(address).catch(() => null);
    return meta?.logoURI ? meta : (await coinGeckoProvider.getTokenMetadata(address).catch(() => null)) ?? meta;
  },
  async getTokenOhlcv(address: Address, timeframe: Timeframe, hint?: TokenMarketData | null) {
    const candles = await keylessProvider.getTokenOhlcv(address, timeframe, hint).catch(() => []);
    if (candles.length) return candles;
    const fallback = await coinGeckoProvider.getTokenOhlcv(address, timeframe).catch(() => []);
    const expected = hint?.priceUsd;
    const close = fallback.at(-1)?.close;
    return expected && close && Math.abs(close - expected) / expected > 0.25 ? [] : fallback;
  },
};

export function getMarketDataProvider(): MarketDataProvider {
  return serverEnv().COINGECKO_API_KEY ? fallbackProvider : keylessProvider;
}
