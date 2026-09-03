import type { MarketDataProvider } from "@/domain/market";
import { serverEnv } from "@/config/env";
import { coinGeckoProvider } from "./coingecko/adapter";
import { keylessProvider } from "./keyless/adapter";

/**
 * Market data is an enrichment layer, never a trading dependency.
 * Default: keyless (DexScreener + GeckoTerminal) behind a shared server cache.
 * With COINGECKO_API_KEY the paid onchain API is used instead. Swap here without touching UI code.
 */
export function getMarketDataProvider(): MarketDataProvider {
  return serverEnv().COINGECKO_API_KEY ? coinGeckoProvider : keylessProvider;
}
