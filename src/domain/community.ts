import type { Address, Hash } from "viem";
import type { Allocation } from "./portfolio";

export interface Profile {
  address: Address;
  handle?: string;
  displayName?: string;
  bio?: string;
  isPublic: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CommunityBasket {
  id: string;
  owner: Address;
  name: string;
  description: string;
  allocations: Allocation[];
  clones: number;
  votes: number;
  createdAt: number;
  updatedAt: number;
}

export interface Referral {
  referee: Address;
  referrer: Address;
  firstTradeTx?: Hash;
  createdAt: number;
}

export interface PortfolioSnapshotRow {
  address: Address;
  /** YYYY-MM-DD (UTC). */
  day: string;
  totalUsd: number;
  holdings: Array<{ assetAddress: Address; symbol: string; valueUsd: number; weightBps: number }>;
  createdAt: number;
}

export type AutomationType = "recurring-buy" | "recurring-basket" | "drift-alert";

export interface AutomationRule {
  id: string;
  owner: Address;
  type: AutomationType;
  config: {
    assetAddress?: Address;
    basketName?: string;
    allocations?: Allocation[];
    amountUsd?: number;
    cadenceDays?: number;
    thresholdBps?: number;
    templateId?: string;
  };
  status: "proposed" | "active" | "paused";
  nextRunAt?: number;
  lastRunAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Badge {
  id: string;
  label: string;
  description: string;
  earned: boolean;
  earnedAt?: number;
  /** How far along the wallet is (server-computed), for locked badges. */
  progress?: { current: number; target: number };
}

export interface CommunityPulse {
  window: "7d";
  mostBought: Array<{ assetAddress: Address; symbol: string; trades: number; usd: number }>;
  mostSold: Array<{ assetAddress: Address; symbol: string; trades: number; usd: number }>;
  topBaskets: CommunityBasket[];
  traders: number;
  updatedAt: number;
}
