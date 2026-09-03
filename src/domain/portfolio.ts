import type { Address, Hash } from "viem";

export const USDC_ALLOCATION_KEY = "USDC" as const;
export type AllocationTarget = Address | typeof USDC_ALLOCATION_KEY;
export const TOTAL_BPS = 10_000;

export interface Allocation {
  assetAddress: AllocationTarget;
  weightBps: number;
}

export interface PortfolioTemplate {
  id: string;
  slug: string;
  name: string;
  description: string;
  allocations: Allocation[];
  active: boolean;
}

export interface PortfolioHolding {
  assetAddress: Address;
  symbol: string;
  name: string;
  underlying: string;
  logoURI?: string;
  rawBalance: string;
  /** Multiplier-aware share-equivalents (from scaledBalanceOf). */
  scaledBalance: string;
  decimals: number;
  multiplier: string;
  marketValueUsd: number;
  referenceValueUsd: number | null;
  priceUsd: number | null;
  priceSource: "market" | "reference" | "none";
  change24hPct: number | null;
  targetWeightBps?: number;
  currentWeightBps: number;
}

/** USDC deposited in a yield venue (Morpho, Aave, Compound); counted in total value. */
export interface PortfolioEarnPosition {
  opportunityId: string;
  provider: string;
  title: string;
  valueUsd: number;
  variableApy?: number;
}

/** A concentrated-liquidity position that contains a tokenized stock (Uniswap v3 / Aerodrome Slipstream). */
export interface PortfolioLpPosition {
  manager: string;
  managerLabel: string;
  provider: "uniswap" | "aerodrome";
  tokenId: string;
  pair: string;
  stockAddress: Address | null;
  stockSymbol: string | null;
  /** Stock tokens currently inside the position (token units). */
  stockAmount: number;
  quoteSymbol: string;
  quoteAmount: number;
  valueUsd: number | null;
  feesUsd: number | null;
  inRange: boolean;
  manageUrl: string;
}

export interface PortfolioSnapshot {
  owner: Address;
  /** Stocks + cash USDC + USDC in Earn + liquidity positions holding a stock. */
  totalValueUsd: number;
  usdcBalance: string;
  usdcValueUsd: number;
  earnValueUsd: number;
  earnPositions: PortfolioEarnPosition[];
  /** Liquidity positions holding a tokenized stock; counted in the total. */
  lpValueUsd: number;
  lpPositions: PortfolioLpPosition[];
  holdings: PortfolioHolding[];
  /** Weighted 24h change across priced holdings. */
  change24hPct: number | null;
  readAt: number;
}

export type PortfolioExecutionStatus =
  | "READY"
  | "QUOTING"
  | "AWAITING_USER"
  | "EXECUTING"
  | "PARTIALLY_FILLED"
  | "COMPLETE"
  | "FAILED";

export type PortfolioStepStatus = "pending" | "quoted" | "submitted" | "confirmed" | "failed";

export interface PortfolioExecutionStep {
  id: string;
  assetAddress: Address;
  symbol: string;
  /** "buy" spends USDC (sellAmountUsdc); "sell" sells B20 raw units (sellAmount). */
  side?: "buy" | "sell";
  targetUsd: number;
  sellAmountUsdc: string;
  /** Raw B20 units for sell legs. */
  sellAmount?: string;
  provider?: string;
  status: PortfolioStepStatus;
  txHash?: Hash;
  errorCode?: string;
  errorMessage?: string;
}

export interface PortfolioExecution {
  id: string;
  owner: Address;
  status: PortfolioExecutionStatus;
  totalUsd: number;
  steps: PortfolioExecutionStep[];
  createdAt: number;
  updatedAt: number;
}

/** Structured intent produced by validation (and optionally by the AI helper). Never contains calldata. */
export interface PortfolioIntent {
  name?: string;
  allocations: Allocation[];
  /** Source of the intent for auditing. */
  source: "template" | "custom" | "ai";
  notes?: string;
}

export interface PortfolioPlanLeg {
  assetAddress: Address;
  symbol: string;
  weightBps: number;
  targetUsd: number;
  sellAmountUsdc: string;
  /** Present when the plan was quoted. */
  estimatedBuyAmount?: string;
  estimatedPriceUsd?: number | null;
  provider?: string;
  quoteError?: string;
}

export type DeferredPolicy = "reserve" | "redistribute";

/** An allocation that cannot be bought yet: the token exists but Coinbase has not minted it on Base. */
export interface PortfolioPlanDeferred {
  assetAddress: Address;
  symbol: string;
  weightBps: number;
  targetUsd: number;
  reason: string;
}

export interface PortfolioPlan {
  totalUsd: number;
  keepUsdcUsd: number;
  keepUsdcBps: number;
  legs: PortfolioPlanLeg[];
  /** Not-issued names: money kept as USDC ("reserve") or spread over live names ("redistribute"). */
  deferred?: PortfolioPlanDeferred[];
  deferredPolicy?: DeferredPolicy;
  minTradeUsd: number;
  warnings: string[];
}

export interface RebalanceSuggestion {
  assetAddress: AllocationTarget;
  symbol: string;
  currentWeightBps: number;
  targetWeightBps: number;
  deltaUsd: number;
  action: "buy" | "sell" | "hold";
}
