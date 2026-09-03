import type { Address, Hash } from "viem";

export type ActivityType =
  | "buy"
  | "sell"
  | "send"
  | "receive"
  | "portfolio-build"
  | "earn-supply"
  | "earn-withdraw"
  | "earn-liquidity"
  | "approve"
  | "unknown";

export interface ActivityItem {
  id: string;
  owner: Address;
  type: ActivityType;
  txHash: Hash;
  blockNumber?: number;
  /** Unix seconds. */
  timestamp?: number;
  assetAddress?: Address;
  symbol?: string;
  amountUsd?: number;
  rawAmount?: string;
  decimals?: number;
  counterparty?: Address;
  counterpartyBasename?: string;
  /** BStocks handle of the counterparty when they have a profile here. */
  counterpartyHandle?: string;
  provider?: string;
  /** "app" records are never proof until matched with chain state. */
  source: "app" | "receipt" | "onchain";
  verified: boolean;
  metadata?: Record<string, unknown>;
}
