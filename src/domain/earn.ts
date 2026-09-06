import type { Address, Hex } from "viem";

export type EarnProviderId = "morpho" | "aave" | "aerodrome" | "compound" | "uniswap";
export type EarnType = "supply" | "vault" | "liquidity" | "borrow";
export type RiskLabel = "lower" | "medium" | "higher" | "unknown";

export interface EarnOpportunity {
  id: string;
  provider: EarnProviderId;
  assetAddress: Address;
  type: EarnType;
  title: string;
  variableApy?: number;
  rewardsApr?: number;
  tvlUsd?: number;
  liquidityUsd?: number;
  riskLabel: RiskLabel;
  /** Unix ms of the provider data used for APY/TVL. Required for display. */
  dataTimestamp: number;
  /** External link for the user to inspect the venue. */
  url?: string;
  /** Plain-language risk notes shown on confirmation. */
  risks: string[];
  /** True when BaseStocks can build deposit/withdraw calls itself (otherwise the user continues at the venue). */
  inApp: boolean;
  metadata: Record<string, unknown>;
}

export interface EarnIntent {
  opportunityId: string;
  user: Address;
  /** Base units of the underlying asset. For withdrawals, `max` withdraws everything. */
  amount: bigint | "max";
  action: "deposit" | "withdraw";
}

export interface EarnCall {
  kind: "approve" | "deposit" | "withdraw";
  to: Address;
  data: Hex;
  value: bigint;
}

export interface EarnExecution {
  calls: EarnCall[];
  description: string;
  /** Spender to approve for deposits (the vault / pool). */
  spender?: Address;
  underlying: Address;
  underlyingDecimals: number;
}

export interface EarnPosition {
  opportunityId: string;
  provider: EarnProviderId;
  title: string;
  underlying: Address;
  underlyingSymbol: string;
  underlyingDecimals: number;
  /** Underlying-denominated value of the position. */
  assets: bigint;
  valueUsd: number;
  variableApy?: number;
}

export interface EarnProvider {
  id: EarnProviderId;
  discover(asset: Address, user?: Address): Promise<EarnOpportunity[]>;
  prepare(input: EarnIntent): Promise<EarnExecution>;
}
