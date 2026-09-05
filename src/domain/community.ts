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

export interface PortfolioSnapshotRow {
  address: Address;
  /** YYYY-MM-DD (UTC). */
  day: string;
  totalUsd: number;
  holdings: Array<{ assetAddress: Address; symbol: string; valueUsd: number; weightBps: number }>;
  createdAt: number;
}

export type AutomationType = "recurring-buy" | "recurring-basket" | "drift-alert";

/**
 * How a plan's runs happen. `manual`: the app proposes a due run and the owner confirms every trade
 * in their wallet. `auto`: the plan lives in the AutoInvest contract and a keeper (or the owner)
 * triggers due runs; the chain enforces amount, cadence, route and output.
 */
export type AutomationMode = "manual" | "auto";

/** One leg of a run as it was recorded. */
export interface AutomationRunLeg {
  assetAddress: Address;
  symbol?: string;
  spentUsd: number;
  /** Raw stock units received (buy legs). */
  received?: string;
  provider?: string;
  /** Why the leg did not run, when it did not. */
  skipped?: string;
}

/** A run that happened (or was attempted), newest first in `config.history`. */
export interface AutomationRunRecord {
  at: number;
  ok: boolean;
  via: "keeper" | "wallet";
  txHash?: Hash;
  spentUsd?: number;
  legs?: AutomationRunLeg[];
  error?: string;
  /** A run that did its job without buying — the mix was already in balance. */
  note?: string;
}

/** Mirror of an onchain AutoInvest plan, refreshed from the chain on every read. */
export interface AutomationOnchain {
  contract: Address;
  planId: string;
  createdTx?: Hash;
  syncedAt: number;
  status: "active" | "paused" | "cancelled";
  /** Unix ms. */
  nextRunAt: number;
  lastRunAt: number;
  runs: number;
  /** USDC base units. */
  amountPerRun: string;
  /** Seconds. */
  interval: number;
  /** Unix ms; 0 = none. */
  expiryAt: number;
  maxSlippageBps: number;
  funding?: { usdcBalance: string; allowance: string; enough: boolean; runsCovered: number };
}

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
    mode?: AutomationMode;
    /**
     * A manual basket plan that, on each run, buys only what is under the saved target — legs are
     * computed from the live holdings at run time, never sells, never runs unattended.
     */
    towardTarget?: boolean;
    maxSlippageBps?: number;
    /** Unix ms; undefined = no expiry. */
    expiryAt?: number;
    onchain?: AutomationOnchain;
    /** Newest first, capped. */
    history?: AutomationRunRecord[];
    /** The keeper's last failed attempt and when it will try again. */
    lastError?: { at: number; message: string; retryAt?: number };
    /** Set while a keeper tick is executing this plan; stale after a few minutes. */
    runningSince?: number;
  };
  status: "proposed" | "active" | "paused" | "cancelled";
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
