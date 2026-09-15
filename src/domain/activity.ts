import type { Address, Hash } from "viem";

export type ActivityType =
  | "buy"
  | "sell"
  | "send"
  | "receive"
  /** A basket or rebalance: several purchases, one row, the legs inside it. */
  | "portfolio-build"
  /** One AutoInvest run: one transaction, one row, the stocks it bought inside it. */
  | "auto-invest"
  | "earn-supply"
  | "earn-withdraw"
  /** Stock and USDC put into a liquidity position. */
  | "earn-liquidity"
  /** Fees taken out of a liquidity position. */
  | "earn-collect"
  /** The deposit that funds a gift pool. */
  | "pool-create"
  /** Taking one share from a gift pool. */
  | "pool-claim"
  | "approve"
  | "unknown";

/** One purchase (or sale) inside a grouped row. */
export interface ActivityLeg {
  assetAddress: Address;
  symbol: string;
  amountUsd?: number;
  rawAmount?: string;
  decimals?: number;
  /** B20 multiplier (WAD string) and precision; present when the stock is known, so raw units read as shares. */
  multiplier?: string;
  wadPrecision?: string;
  txHash?: Hash;
  status: "confirmed" | "failed" | "pending";
  provider?: string;
}

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
  multiplier?: string;
  wadPrecision?: string;
  counterparty?: Address;
  counterpartyBasename?: string;
  /** BStocks handle of the counterparty when they have a profile here. */
  counterpartyHandle?: string;
  provider?: string;
  /** "app" records are never proof until matched with chain state. */
  source: "app" | "receipt" | "onchain";
  verified: boolean;
  /** Present on grouped rows (a basket, an auto-invest run, a pool): what each leg did. */
  legs?: ActivityLeg[];
  /** How many records this row stands for (e.g. ten gift links funded in one transaction). */
  count?: number;
  metadata?: Record<string, unknown>;
}
