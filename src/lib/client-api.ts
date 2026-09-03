import type { B20AssetDTO } from "@/domain/asset";
import type { Candle, PriceView, Timeframe, TokenMarketData } from "@/domain/market";
import type { ExecutableQuoteDTO, TradeErrorCode, TradeProviderId, TradeQuoteSummary, TradeSide } from "@/domain/trade";
import type { ResolvedRecipient } from "@/domain/gift";
import type { PortfolioExecution, PortfolioPlan, PortfolioSnapshot, PortfolioTemplate, Allocation } from "@/domain/portfolio";
import type { EarnOpportunity } from "@/domain/earn";
import type { ActivityItem } from "@/domain/activity";
import type { GiftRecord } from "@/domain/gift";
import type { Address, Hash } from "viem";

/** Typed client for our own API routes. Provider shapes never reach the browser. */
export class ApiError extends Error {
  constructor(
    public readonly code: TradeErrorCode | string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
    throw new ApiError(err?.code ?? "UNKNOWN", err?.message ?? `Request failed (${res.status})`, res.status, err?.details);
  }
  return body as T;
}

export const apiGet = <T>(path: string) => request<T>(path, { method: "GET" });
export const apiPost = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });
export const apiPatch = <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const apiPut = <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const apiDelete = <T>(path: string, body: unknown) => request<T>(path, { method: "DELETE", body: JSON.stringify(body) });

/* ---------- Response types ---------- */

export interface ConfigResponse {
  aiEnabled: boolean;
  tradeProviders: string[];
  marketDataEnabled: boolean;
  /** 0x tokenized-stock status (refused until 0x approves the opt-in). */
  zeroX?: { configured: boolean; refusesTokenizedStocks: boolean; since: number | null; retryAt: number | null; lastError: string | null };
  geoblockCountries?: string[];
  storage: "memory" | "supabase";
  minTradeUsd: number;
  defaultSlippageBps: number;
}

export interface AssetsResponse {
  assets: B20AssetDTO[];
  prices: Record<string, PriceView>;
  /** Chainlink ETH/USD, for paying with ETH and fee display. */
  ethUsd?: number | null;
  readAt: number;
}

export interface AssetResponse {
  asset: B20AssetDTO;
  price: PriceView | null;
}

export interface MarketResponse {
  market: TokenMarketData | null;
  enabled: boolean;
}

export interface ChartResponse {
  candles: Candle[];
  source: "market" | "reference";
  timeframe: Timeframe;
}

export interface TradePriceRequest {
  side: TradeSide;
  payWith?: "USDC" | "ETH";
  provider?: TradeProviderId;
  assetAddress: Address;
  sellAmount: string;
  taker?: Address;
  recipient?: Address;
  slippageBps?: number;
  chainId?: number;
}

export interface PlanRequest {
  allocations: Allocation[];
  totalUsd: number;
  taker?: Address;
  quote?: boolean;
  source?: "template" | "custom" | "ai";
}

export interface PlanResponse {
  ok: boolean;
  plan?: PortfolioPlan;
  errors?: string[];
}

export interface EarnResponse {
  assetAddress: Address;
  opportunities: EarnOpportunity[];
  unavailableProviders: string[];
  updatedAt: number;
}

export interface TxStatusResponse {
  status: "unknown" | "submitted" | "preconfirmed" | "confirmed" | "failed";
  blockNumber?: number;
  via: string;
}

/** AI-drafted automation plan; prefills the form, never saved or run by itself. */
export interface AutomationDraft {
  type: "recurring-buy" | "recurring-basket";
  assetAddress?: Address;
  symbol?: string;
  basketName?: string;
  allocations?: Allocation[];
  amountUsd: number;
  cadenceDays: number;
  notes: string;
}

export interface PoolRowDTO {
  address: Address;
  name: string;
  dexId: string;
  dexLabel: string;
  known: boolean;
  reserveUsd: number;
  volume24hUsd: number | null;
  primary: boolean;
  routes: boolean;
  lpTracked: boolean;
  inEarn: boolean;
  url: string | null;
}

export interface PoolMapResponse {
  asset: Address;
  primaryPool: Address | null;
  pools: PoolRowDTO[];
  totals: { count: number; known: number; liquidityUsd: number; volume24hUsd: number };
  updatedAt: number;
}

export interface RegionResponse {
  country: string | null;
  /** Countries in GEOBLOCK_COUNTRIES. */
  blocked: string[];
  /** block = hard 451; attest = warning plus self-certification cookie. */
  mode: "block" | "attest";
  blockedCountry: boolean;
  attested: boolean;
  /** True when execution routes answer 451 for this visitor right now. */
  restricted: boolean;
}

/** A concentrated-liquidity position (Uniswap v3 / Aerodrome Slipstream) holding a tokenized stock. */
export interface LpPositionDTO {
  manager: string;
  managerLabel: string;
  provider: "uniswap" | "aerodrome";
  tokenId: string;
  pool: Address;
  token0: { address: Address; symbol: string; decimals: number };
  token1: { address: Address; symbol: string; decimals: number };
  feeOrTickSpacing: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  inRange: boolean;
  rangeUsd: { lower: number; upper: number; current: number } | null;
  amount0: number;
  amount1: number;
  valueUsd: number | null;
  fees: { amount0: number; amount1: number; usd: number | null };
  manageUrl: string;
}

export interface ResolveResponse {
  input: string;
  resolved: ResolvedRecipient | null;
}

export interface ReverseResponse {
  address: Address;
  name: string | null;
  avatar: string | null;
}

export interface CorporateActionEvent {
  kind: "announcement" | "end-announcement" | "multiplier" | "multiplier-scheduled" | "multiplier-cancelled" | "metadata";
  id?: string;
  description?: string;
  uri?: string;
  multiplier?: string;
  blockNumber: number;
  timestamp?: number;
  txHash: string;
}

export interface AnnouncementsResponse {
  assetAddress: Address;
  events: CorporateActionEvent[];
  scannedFromBlock: number;
  updatedAt: number;
}

export interface IntentResponse {
  ok: boolean;
  intent?: { name?: string; allocations: Allocation[]; notes?: string; source: "ai" };
  errors?: string[];
}

export type { TradeQuoteSummary, ExecutableQuoteDTO, PortfolioSnapshot, PortfolioTemplate, PortfolioExecution, ActivityItem, GiftRecord, Hash };
