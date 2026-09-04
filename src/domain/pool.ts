import type { Address, Hash, Hex } from "viem";

/**
 * How a pool decides who may take a share. All three map onto the same onchain check — the
 * contract only ever asks "is `gate` address(0), or did `gate` sign this ticket?".
 *
 * - `open`   — anyone, one share per address, self-claim only. Public giveaways.
 * - `link`   — whoever holds the share link; its fragment carries an ephemeral key that signs
 *              each claim in the claimant's browser. Never reaches a server.
 * - `signer` — the app's campaign signer, which only signs after the quests below verify.
 */
export type PoolGateMode = "open" | "link" | "signer";

export type PoolVisibility = "public" | "unlisted";

export type PoolStatus = "draft" | "submitted" | "live" | "cancelled" | "expired" | "failed";

/**
 * A quest is verified offchain and gates the ticket signature, never the contract. Only checks
 * that can be proven from the chain or from a signature are listed here on purpose: a "follow us
 * on X" style task cannot be verified with the free API, and promising it would be a lie.
 */
export type QuestType = "sign-in" | "hold-basename" | "hold-asset" | "buy-asset";

export interface Quest {
  type: QuestType;
  /** `hold-asset` / `buy-asset`: which stock. */
  assetAddress?: Address;
  /** `hold-asset`: minimum raw balance the claimant must hold right now. */
  minRawAmount?: string;
  /** `buy-asset`: minimum USD value of a verified purchase. */
  minUsd?: number;
  /** `buy-asset`: how far back purchases count (default 30 days). */
  withinDays?: number;
}

export interface PoolLeg {
  token: Address;
  /** Raw base units paid to each claimant, per claim. */
  amountPerClaim: string;
}

export interface PoolRecord {
  id: string;
  /** keccak256(abi.encode(creator, salt)) — the id the contract knows. */
  onchainId: Hex;
  creator: Address;
  gateMode: PoolGateMode;
  /** address(0) for `open`; the link key or the campaign signer otherwise. */
  gateAddress: Address;
  slots: number;
  legs: PoolLeg[];
  /** Unix ms; no claim is possible after this. */
  expiry: number;
  /** Unix ms before which the creator cannot cancel (0 = cancellable at once). */
  lockedUntil: number;
  visibility: PoolVisibility;
  /** Admin flag; only verified pools are promoted in the public directory. */
  verified: boolean;
  title?: string;
  message?: string;
  quests: Quest[];
  memo: Hex;
  txHash?: Hash;
  status: PoolStatus;
  createdAt: number;
}

export type PoolClaimStatus = "issued" | "confirmed" | "reconciled";

export interface PoolClaim {
  poolId: string;
  claimant: Address;
  status: PoolClaimStatus;
  /** What the quest verifier saw, kept for the creator's audit view. */
  questProof: Record<string, unknown>;
  txHash?: Hash;
  blockNumber?: number;
  createdAt: number;
}

/** Onchain truth for a pool, read straight from the contract. */
export interface PoolOnchainState {
  exists: boolean;
  creator: Address;
  gate: Address;
  slots: number;
  claimed: number;
  expiry: number;
  lockedUntil: number;
  cancelled: boolean;
  remainingSlots: number;
  legs: Array<{ token: Address; amountPerClaim: string; withdrawn: boolean }>;
}

/** One leg of a pool, resolved against the asset registry for display. */
export interface PoolLegView extends PoolLeg {
  symbol: string;
  underlying: string;
  decimals: number;
  logoURI?: string;
  /** Share-equivalent amount per claim (raw × multiplier / WAD). */
  scaledPerClaim: string;
  usdPerClaim: number | null;
}

export interface PoolView {
  pool: PoolRecord;
  onchain: PoolOnchainState | null;
  legs: PoolLegView[];
  /** Sum of `usdPerClaim` across legs, when every leg has a price. */
  usdPerClaim: number | null;
  claimCount: number;
  creatorBasename: string | null;
}

/** What a claimant is told about their own eligibility, before they spend gas. */
export interface QuestStatus {
  type: QuestType;
  label: string;
  done: boolean;
  /** Why it is not done yet, in the claimant's language. */
  detail?: string;
}
