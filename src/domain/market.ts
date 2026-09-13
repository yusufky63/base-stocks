import type { Address } from "viem";
import type { ReferenceFreshness } from "@/lib/market-hours";

export type Timeframe = "1D" | "1W" | "1M" | "3M" | "1Y";
export const TIMEFRAMES: Timeframe[] = ["1D", "1W", "1M", "3M", "1Y"];

export interface Candle {
  /** Unix seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TokenMarketData {
  address: Address;
  /** USD price per one raw token. */
  priceUsd: number | null;
  change24hPct: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  /** Provider id, e.g. "coingecko". */
  source: string;
  /** Unix ms of the snapshot. */
  updatedAt: number;
  /** Primary pool used for OHLCV, when known. */
  primaryPool?: Address;
}

export interface TokenMetadata {
  address: Address;
  name?: string;
  symbol?: string;
  logoURI?: string;
  decimals?: number;
}

export interface MarketDataProvider {
  id: string;
  getTokenMarkets(addresses: Address[]): Promise<Map<string, TokenMarketData>>;
  getTokenMarket(address: Address): Promise<TokenMarketData | null>;
  /** `hint` is a reading the caller already holds, so the adapter need not fetch one to validate the series. */
  getTokenOhlcv(address: Address, timeframe: Timeframe, hint?: TokenMarketData | null): Promise<Candle[]>;
  getTokenMetadata(address: Address): Promise<TokenMetadata | null>;
}

/** Unified price view kept deliberately as three separate concepts. */
export interface PriceView {
  address: Address;
  /** Market-data provider (DEX-oriented). */
  marketUsd: number | null;
  marketChange24hPct: number | null;
  marketUpdatedAt: number | null;
  /** Total DEX liquidity for the token (USD) when the provider reports it. */
  liquidityUsd: number | null;
  /** 24h DEX volume (USD) when the provider reports it. */
  volume24hUsd: number | null;
  /** Reference-feed freshness classification (live / last-close / stale / frozen). */
  referenceFreshness: ReferenceFreshness;
  /** Chainlink reference (total-return, multiplier adjusted). */
  referenceUsd: number | null;
  referenceStale: boolean;
  referencePaused: boolean;
  referenceUpdatedAt: number | null;
  /** Best available display price with its origin. */
  displayUsd: number | null;
  displaySource: "market" | "reference" | "none";
  /** Deviation of market vs reference, in percent, when both exist. */
  deviationPct: number | null;
  /** Why the market price is not the headline while a pool exists: too little depth, or too far from the reference. */
  displayReason?: "thin" | "deviation" | null;
  /** Market cap (or FDV) the market-data provider reports for the token, when it does. */
  marketCapUsd?: number | null;
}
