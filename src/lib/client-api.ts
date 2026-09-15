import type { B20AssetDTO } from "@/domain/asset";
import type { Candle, PriceView, Timeframe } from "@/domain/market";
import type { ExecutableQuoteDTO, OrderView, SignedOrderRequest, TradeErrorCode, TradeProviderId, TradeQuoteSummary, TradeSide } from "@/domain/trade";
import type { ResolvedRecipient } from "@/domain/gift";
import type { PortfolioExecution, PortfolioPlan, PortfolioSnapshot, PortfolioTemplate, Allocation } from "@/domain/portfolio";
import type { EarnOpportunity } from "@/domain/earn";
import type { ActivityItem } from "@/domain/activity";
import type { GiftRecord } from "@/domain/gift";
import type { AutomationRule } from "@/domain/community";
import type { Address, Hash } from "viem";

/** Typed client for our own API routes. Provider shapes never reach the browser. */
export class ApiError extends Error {
  constructor(
    public readonly code: TradeErrorCode | string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
    /** Full JSON body of the failed response (e.g. `errors`, `quota`), when there was one. */
    public readonly body?: Record<string, unknown>,
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
    const errors = (body as { errors?: unknown } | null)?.errors;
    const firstError = Array.isArray(errors) && typeof errors[0] === "string" ? errors[0] : undefined;
    throw new ApiError(err?.code ?? "UNKNOWN", err?.message ?? firstError ?? `Request failed (${res.status})`, res.status, err?.details, body && typeof body === "object" ? (body as Record<string, unknown>) : undefined);
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
  /** False when no campaign signer is configured: pools cannot ask for steps here. */
  poolQuestsEnabled?: boolean;
  /** AutoInvest contract + keeper availability. */
  autoInvest?: AutoInvestConfig;
  /** Card and Apple Pay top-ups through Coinbase Onramp, when CDP credentials are configured. */
  onramp: boolean;
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
  /** Chainlink ETH/USD, so a stock page need not poll the whole asset list for one number. */
  ethUsd?: number | null;
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
  /** Prefer CoW's batch auction when it is competitive (see the router's best-execution constants). */
  bestExecution?: boolean;
}

export interface PlanRequest {
  allocations: Allocation[];
  totalUsd: number;
  taker?: Address;
  quote?: boolean;
  source?: "template" | "custom" | "ai" | "community" | "automation";
  deferredPolicy?: "reserve" | "redistribute";
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

export interface AutoInvestConfig {
  enabled: boolean;
  address: Address | null;
  keeperConfigured: boolean;
  keeper: Address | null;
}

/** A rule as `/api/automation` returns it: the stored rule plus what is due. */
export type AutomationRuleDTO = AutomationRule & { due: boolean; missed: number };

export interface AutomationListResponse {
  rules: AutomationRuleDTO[];
  autoInvest: AutoInvestConfig;
}

/** One leg of a prepared auto run (`POST /api/automation/prepare-run`). */
export interface PreparedRunLeg {
  index: number;
  assetAddress: Address;
  symbol: string;
  amountIn: string;
  usd: number;
  provider: string | null;
  expectedOut: string | null;
  skipped: string | null;
}

export interface PreparedRunResponse {
  planId: string;
  total: string;
  legs: PreparedRunLeg[];
  swaps: Array<{ target: Address; spender: Address; amountIn: string; minOut: string; data: `0x${string}` }>;
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
  /** Why this plan, and what to keep an eye on — commentary, not advice. */
  commentary?: { why: string; watch: string[] };
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
  /** Raw position liquidity, needed to build a decreaseLiquidity call. */
  liquidity: string;
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

/**
 * The assistant's reasoning next to a draft: grounded in the live universe, the shared market
 * brief and the headlines it was given. Commentary, never advice — the UI says so every time.
 */
export interface DraftCommentary {
  /** One or two sentences: what the mix is built around. */
  thesis: string;
  /** Why each stock is in, and at that weight. */
  legs: Array<{ symbol: string; why: string }>;
  /** What could go against the mix: concentration, thin pools, names not issued, sector overlap. */
  risks: string[];
  /** Facts from the headlines the assistant leaned on, each naming its ticker or "Base". */
  fromNews: string[];
}

export interface IntentResponse {
  ok: boolean;
  intent?: { name?: string; allocations: Allocation[]; notes?: string; source: "ai"; commentary?: DraftCommentary };
  errors?: string[];
}

export type { TradeQuoteSummary, ExecutableQuoteDTO, OrderView, SignedOrderRequest, PortfolioSnapshot, PortfolioTemplate, PortfolioExecution, ActivityItem, GiftRecord, Hash };
