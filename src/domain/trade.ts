import type { Address, Hash, Hex } from "viem";

export type TradeSide = "buy" | "sell";
/** Every route the app can quote; the only values a trade record may name as its provider. */
export const TRADE_PROVIDER_IDS = ["zeroX", "kyber", "okx", "uniswap", "velora", "aerodrome", "cow"] as const;
export type TradeProviderId = (typeof TRADE_PROVIDER_IDS)[number];

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
  /** The integrator fee this route was asked to charge, in basis points; absent when none was. */
  integratorFeeBps?: number;
}

/**
 * A CoW Protocol intent: the user signs this EIP-712 message instead of sending a transaction;
 * solvers execute it and pay the gas. `appData` is the full JSON document whose keccak256 is the
 * bytes32 in the message; the order book validates the pair.
 */
export interface SignedOrderRequest {
  provider: "cow";
  orderClass: "market" | "limit";
  typedData: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Address };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: "Order";
    message: {
      sellToken: Address;
      buyToken: Address;
      receiver: Address;
      sellAmount: string;
      buyAmount: string;
      validTo: number;
      appData: Hex;
      feeAmount: string;
      kind: "sell" | "buy";
      partiallyFillable: boolean;
      sellTokenBalance: "erc20";
      buyTokenBalance: "erc20";
    };
  };
  appData: string;
  appDataHash: Hex;
  quoteId: number | null;
  /** Spender to approve for the sell token (GPv2VaultRelayer). */
  allowanceTarget: Address;
}

export interface ExecutableQuote extends IndicativeQuote {
  /** Calldata to send; null for signed-order providers (see `order`). */
  transaction: {
    to: Address;
    data: Hex;
    value: bigint;
    gas: bigint | null;
    gasPrice: bigint | null;
  } | null;
  /** Present for signed-order providers (CoW): what the wallet signs and how it is submitted. */
  order?: SignedOrderRequest;
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
  /** True when the fee above was priced by the app (gas estimate × gas price), not reported by the provider. */
  networkFeeEstimated?: boolean;
  /** USD per token implied by this provider's output. */
  executablePriceUsd: number | null;
}

/**
 * What the router did about best execution, for the panel to explain. `mode` is what the request
 * asked for; `applied` says whether CoW's batch auction took the trade; `suggested` says the trade
 * is large enough, and CoW competitive enough, that the panel should offer the mode.
 */
export interface TradeExecutionAdvice {
  mode: "swap" | "best";
  applied: boolean;
  suggested: boolean;
  /** One sentence for the panel; null when there is nothing to say. */
  note: string | null;
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
  /** Executable price vs the Chainlink reference (positive = worse for user); null when the reference is stale, paused or absent. */
  referenceGapPct?: number | null;
  estimatedNetworkFeeWei: string | null;
  estimatedNetworkFeeUsd: number | null;
  /** True when the fee above is the app's estimate rather than the provider's own figure. */
  networkFeeEstimated?: boolean;
  /** BaseStocks' own fee on this route, already inside the amounts above; null when this route charges none. */
  integratorFee: { bps: number; usd: number | null } | null;
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
  /** Best execution: whether CoW's batch auction took the trade, or should be offered. */
  execution?: TradeExecutionAdvice;
}

export interface ExecutableQuoteDTO extends TradeQuoteSummary {
  transaction: {
    to: Address;
    data: Hex;
    value: string;
    gas: string | null;
    gasPrice: string | null;
  } | null;
  order?: SignedOrderRequest;
  quoteId: string | null;
  expiresAt: number;
}

/** Normalized CoW order as shown in "Your orders" and polled after submission. */
export interface OrderView {
  uid: string;
  /** The wallet that signed the order, as the order book reports it. */
  owner: Address | null;
  provider: "cow";
  status: "open" | "fulfilled" | "cancelled" | "expired" | "presignaturePending";
  orderClass: "market" | "limit" | "liquidity";
  side: TradeSide;
  assetAddress: Address | null;
  sellToken: Address;
  buyToken: Address;
  sellAmount: string;
  buyAmount: string;
  executedSellAmount: string;
  executedBuyAmount: string;
  partiallyFillable: boolean;
  validTo: number;
  createdAt: number;
  /** Settlement transaction once (partly) filled. */
  txHash: Hash | null;
  explorerUrl: string;
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
