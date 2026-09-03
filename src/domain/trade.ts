import type { Address, Hex } from "viem";

export type TradeSide = "buy" | "sell";
export type TradeProviderId = "zeroX" | "kyber" | "okx" | "uniswap" | "velora" | "aerodrome";

/** App-owned trade request. Always exact-in. */
export interface TradeIntent {
  chainId: number;
  side: TradeSide;
  /** B20 asset being bought or sold. */
  assetAddress: Address;
  sellToken: Address;
  buyToken: Address;
  /** Base units of sellToken. */
  sellAmount: bigint;
  sellTokenDecimals?: number;
  buyTokenDecimals?: number;
  taker?: Address;
  /** Optional output recipient (buy-for-recipient). */
  recipient?: Address;
  slippageBps: number;
}

export interface RouteFill {
  source: string;
  proportionBps: number | null;
}

export interface IndicativeQuote {
  provider: TradeProviderId;
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  buyAmount: bigint;
  minBuyAmount: bigint | null;
  /** Estimated gas units. */
  gas: bigint | null;
  gasPrice: bigint | null;
  /** Total network fee in wei, when the provider reports it. */
  totalNetworkFeeWei: bigint | null;
  liquidityAvailable: boolean;
  /** Spender to approve. Only ever taken from the provider response. */
  allowanceTarget: Address | null;
  route: RouteFill[];
  /** Provider-side flags that must be surfaced, never hidden. */
  issues: {
    allowanceRequired: boolean;
    allowanceSpender: Address | null;
    balanceInsufficient: boolean;
    simulationIncomplete: boolean;
  };
  /** Unix ms when fetched; indicative quotes are short-lived. */
  fetchedAt: number;
}

export interface ExecutableQuote extends IndicativeQuote {
  transaction: {
    to: Address;
    data: Hex;
    value: bigint;
    gas: bigint | null;
    gasPrice: bigint | null;
  };
  /** Opaque provider quote id for observability. */
  quoteId: string | null;
  /** Unix ms after which the client must refetch. */
  expiresAt: number;
}

/** One provider's answer in the comparison (integration guide §41–42: best net output, not just highest output). */
export interface TradeQuoteAlternative {
  provider: TradeProviderId;
  buyAmount: string | null;
  /** Output in USD minus estimated network fee; null when the provider failed. */
  netUsd: number | null;
  latencyMs: number;
  route: string;
  error?: string;
  best: boolean;
  /** Output valued in USD before fees (null when no price basis). */
  outUsd: number | null;
  estimatedNetworkFeeUsd: number | null;
  /** USD per token implied by this provider's output. */
  executablePriceUsd: number | null;
}

/** Normalized summary the UI renders; browser never sees provider shapes. */
export interface TradeQuoteSummary {
  provider: TradeProviderId;
  side: TradeSide;
  assetAddress: Address;
  sellToken: Address;
  buyToken: Address;
  sellAmount: string;
  buyAmount: string;
  minBuyAmount: string | null;
  /** Executable USD price per one raw token. */
  executablePriceUsd: number | null;
  /** Executable USD price per one share-equivalent (token price / multiplier). */
  executablePricePerShareUsd: number | null;
  /** Percent difference of executable price vs basis price (positive = worse for user). */
  priceImpactPct: number | null;
  priceImpactBasis: "reference" | "market" | null;
  estimatedNetworkFeeWei: string | null;
  estimatedNetworkFeeUsd: number | null;
  liquidityAvailable: boolean;
  allowanceRequired: boolean;
  allowanceSpender: Address | null;
  balanceInsufficient: boolean;
  route: RouteFill[];
  fetchedAt: number;
  /** Non-blocking warnings (stale oracle etc.). */
  warnings: string[];
  /** Every configured provider's answer for this exact amount, best first (indicative prices only). */
  alternatives?: TradeQuoteAlternative[];
}

export interface ExecutableQuoteDTO extends TradeQuoteSummary {
  transaction: {
    to: Address;
    data: Hex;
    value: string;
    gas: string | null;
    gasPrice: string | null;
  };
  quoteId: string | null;
  expiresAt: number;
}

export type TradeErrorCode =
  | "INSUFFICIENT_BALANCE"
  | "ALLOWANCE_REQUIRED"
  | "B20_POLICY_BLOCKED"
  | "B20_TRANSFER_PAUSED"
  | "QUOTE_EXPIRED"
  | "ROUTE_UNAVAILABLE"
  | "SLIPPAGE"
  | "WRONG_NETWORK"
  | "USER_REJECTED"
  | "PROVIDER_UNAVAILABLE"
  | "ASSET_NOT_CANONICAL"
  | "ASSET_NOT_VERIFIED"
  | "AMOUNT_TOO_SMALL"
  | "SIMULATION_FAILED"
  | "WALLET_NOT_CONNECTED"
  | "UNKNOWN"
  | "REGION_RESTRICTED";

export interface TradeProvider {
  id: TradeProviderId;
  getIndicativeQuote(intent: TradeIntent): Promise<IndicativeQuote>;
  getExecutableQuote(intent: TradeIntent): Promise<ExecutableQuote>;
}

/** Trade sheet state machine (spec §47). */
export type TradeState =
  | "IDLE"
  | "LOADING_PRICE"
  | "READY"
  | "APPROVAL_REQUIRED"
  | "GETTING_FIRM_QUOTE"
  | "AWAITING_WALLET"
  | "SUBMITTED"
  | "PRECONFIRMED"
  | "CONFIRMED"
  | "FAILED";
