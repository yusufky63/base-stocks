import type { Address } from "viem";
import type { Candle, Timeframe, TokenMarketData } from "@/domain/market";
import type { B20Asset } from "@/domain/asset";
import { getMarketDataProvider } from "@/providers/market-data";
import { readRoundHistory, roundsToCandles } from "@/providers/market-data/chainlink/history";
import { metrics } from "@/lib/http";

export interface ChartSeries {
  candles: Candle[];
  /** "market" = DEX OHLCV from the market-data provider; "reference" = Chainlink round history. */
  source: "market" | "reference";
  timeframe: Timeframe;
}

/** Market data is always available now (keyless default); kept for feature flags. */
export function marketDataConfigured(): boolean {
  return true;
}

export function marketDataProviderId(): string {
  return getMarketDataProvider().id;
}

export async function getTokenMarket(address: Address): Promise<TokenMarketData | null> {
  try {
    return await getMarketDataProvider().getTokenMarket(address);
  } catch (err) {
    metrics.count("market.token", false, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Chart series with graceful degradation: DEX OHLCV when the market-data provider is
 * available, otherwise a reference-only reconstruction from Chainlink rounds.
 */
export async function getChartSeries(asset: B20Asset, timeframe: Timeframe): Promise<ChartSeries> {
  try {
    const candles = await getMarketDataProvider().getTokenOhlcv(asset.address, timeframe);
    if (candles.length > 1) return { candles, source: "market", timeframe };
  } catch (err) {
    metrics.count("market.ohlcv", false, err instanceof Error ? err.message : String(err));
  }
  if (asset.oracle) {
    try {
      const rounds = await readRoundHistory(asset.oracle.feed, timeframe === "1Y" || timeframe === "3M" ? 1500 : 900);
      return { candles: roundsToCandles(rounds, timeframe), source: "reference", timeframe };
    } catch (err) {
      metrics.count("chainlink.history", false, err instanceof Error ? err.message : String(err));
    }
  }
  return { candles: [], source: "reference", timeframe };
}
