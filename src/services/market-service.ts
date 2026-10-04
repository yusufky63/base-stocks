import type { Address } from "viem";
import type { Candle, Timeframe } from "@/domain/market";
import { getMarketDataProvider } from "@/providers/market-data";
import { readRoundHistory, roundsToCandles } from "@/providers/market-data/chainlink/history";
import { peekMarketData } from "./price-service";
import { recallGood, rememberGood } from "@/lib/last-good";
import { metrics } from "@/lib/http";

export interface ChartSeries {
  candles: Candle[];
  /** "market" = DEX OHLCV from the market-data provider; "reference" = Chainlink round history. */
  source: "market" | "reference";
  timeframe: Timeframe;
}

/**
 * What a chart needs to know about a stock: the token, and the Chainlink feed to fall back on.
 * Deliberately not the whole asset: assembling one reads supply, multiplier and oracle state from
 * the chain, and a chart request was paying for all of that to learn one address.
 */
export interface ChartSubject {
  address: Address;
  feed?: Address | null;
}

export function marketDataProviderId(): string {
  return getMarketDataProvider().id;
}

/** A remembered series older than this is dropped rather than drawn as if it were current. */
const LAST_GOOD_CANDLES_MAX_AGE_MS = 24 * 3600_000;

/**
 * Chart series with graceful degradation: DEX OHLCV when the market-data provider is
 * available, otherwise a reference-only reconstruction from Chainlink rounds.
 *
 * A stock without a feed has no second source, so its last good DEX series is remembered: the
 * candle provider is keyless and rate limited, and a throttled minute would otherwise leave the
 * whole chart blank. Stocks with a feed do not need it and are not written.
 */
export async function getChartSeries(subject: ChartSubject, timeframe: Timeframe): Promise<ChartSeries> {
  try {
    // The reading the page already fetched validates the candles; a fresh one is fetched only when none is known.
    const hint = await peekMarketData(subject.address);
    const candles = await getMarketDataProvider().getTokenOhlcv(subject.address, timeframe, hint);
    if (candles.length > 1) {
      if (!subject.feed) rememberGood(chartCandlesKey(subject.address, timeframe), candles);
      return { candles, source: "market", timeframe };
    }
  } catch (err) {
    metrics.count("market.ohlcv", false, err instanceof Error ? err.message : String(err));
  }
  if (subject.feed) {
    try {
      const rounds = await readRoundHistory(subject.feed, timeframe === "1Y" || timeframe === "3M" ? 1500 : 900);
      return { candles: roundsToCandles(rounds, timeframe), source: "reference", timeframe };
    } catch (err) {
      metrics.count("chainlink.history", false, err instanceof Error ? err.message : String(err));
    }
  }
  if (!subject.feed) {
    const good = await recallGood<Candle[]>(chartCandlesKey(subject.address, timeframe)).catch(() => null);
    if (good && good.value.length > 1 && Date.now() - good.at <= LAST_GOOD_CANDLES_MAX_AGE_MS) return { candles: good.value, source: "market", timeframe };
  }
  return { candles: [], source: "reference", timeframe };
}

/** Where the last good DEX series of a stock without a feed is remembered; the sparklines read the same entry. */
export function chartCandlesKey(address: Address, timeframe: Timeframe): string {
  return `ohlcv:${address.toLowerCase()}:${timeframe}`;
}
