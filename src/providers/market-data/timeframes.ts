import type { Timeframe } from "@/domain/market";

export interface OhlcvSpec {
  timeframe: "minute" | "hour" | "day";
  aggregate: number;
  limit: number;
}

/** Shared OHLCV request shape for GeckoTerminal / CoinGecko onchain endpoints. */
export const OHLCV_SPECS: Record<Timeframe, OhlcvSpec> = {
  "1D": { timeframe: "minute", aggregate: 5, limit: 288 },
  "1W": { timeframe: "hour", aggregate: 1, limit: 168 },
  "1M": { timeframe: "hour", aggregate: 4, limit: 180 },
  "3M": { timeframe: "day", aggregate: 1, limit: 90 },
  "1Y": { timeframe: "day", aggregate: 1, limit: 365 },
};
