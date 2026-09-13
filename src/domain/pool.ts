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
 * A quest gates the ticket signature, never the contract, so a new requirement is server work
 * rather than a new deployment.
 *
 * Quests come in two grades and the app never blurs them:
 *
 * - **Checked** (`hold-basename`, `hold-asset`, `buy-asset`, `sign-in`) are proven from the chain
 *   or from a signature. A purchase is re-read from its transaction receipt, never trusted from
 *   our own `trade_records`, which an unauthenticated route writes.
 * - **Self-declared** (`follow-bstocks`, `follow-x`, `repost-x`, `like-x`, `visit-url`) are steps
 *   the claimant confirms about themselves. Nobody can prove a follow, a repost, a like or a page
 *   view from outside, so nothing here pretends otherwise: the app records who declared what and
 *   says so on both the claim page and the creator's roster.
 *
 * A pool may repeat a type — two accounts to follow, three links to visit — except for the ones
 * where a second copy would mean nothing (see `SINGLETON_QUESTS`).
 */
export type QuestType = "sign-in" | "hold-basename" | "hold-asset" | "buy-asset" | "follow-bstocks" | "follow-x" | "repost-x" | "like-x" | "visit-url";

/** The quest types the claimant confirms about themselves; everything else is checked. */
export const SELF_DECLARED_QUESTS = ["follow-bstocks", "follow-x", "repost-x", "like-x", "visit-url"] as const satisfies readonly QuestType[];

/** Types that make no sense twice in one pool. Everything else can be added again. */
export const SINGLETON_QUESTS = ["sign-in", "hold-basename", "follow-bstocks"] as const satisfies readonly QuestType[];

export function isSingletonQuest(type: QuestType): boolean {
  return (SINGLETON_QUESTS as readonly string[]).includes(type);
}

export function isSelfDeclared(type: QuestType): boolean {
  return (SELF_DECLARED_QUESTS as readonly string[]).includes(type);
}

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
  /** `follow-x`: the account to follow, without the @. */
  handle?: string;
  /** `repost-x` / `like-x`: the post to act on. */
  tweetUrl?: string;
  /** `visit-url`: any http(s) page — a site, a Discord invite, a Telegram group, a video. */
  url?: string;
  /** `visit-url`: what the creator calls it, e.g. "Read the launch post". */
  label?: string;
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
  /**
   * The GiftPool contract this pool was funded in. Stamped by the server at creation; absent on
   * pools that predate the column, which all live in the first deployment (see `poolContractOf`).
   * Claims, cancels, withdrawals and roster scans go to this address, not to the current one.
   */
  contractAddress?: Address;
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
  /** When the server matched the funding transaction to a `PoolCreated` log for this pool. */
  verifiedAt?: number;
  verifyNote?: string;
  /** When the reconciliation sweep last read this pool's claims; the sweep visits the oldest first. */
  lastReconciledAt?: number;
}

export type PoolClaimStatus = "issued" | "confirmed" | "reconciled";

export interface PoolClaim {
  poolId: string;
  claimant: Address;
  status: PoolClaimStatus;
  /**
   * What the verifier saw, kept for the creator's audit view. Checked quests store their evidence
   * under their own type key; self-declared steps land in `attested` as `{ [questIndex]: unixMs }`
   * so the roster can show what someone said versus what we could prove.
   */
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
  /**
   * Shares taken: the contract's `claimed` whenever the chain answered, else the rows the app has
   * confirmed or matched to a log. Tickets handed out are never counted.
   */
  claimCount: number;
  creatorBasename: string | null;
}

/** What a claimant is told about their own eligibility, before they spend gas. */
export interface QuestStatus {
  /** Position in the pool's quest list; how an attestation addresses one step. */
  index: number;
  type: QuestType;
  label: string;
  done: boolean;
  /** Why it is not done yet, in the claimant's language. */
  detail?: string;
  /** Self-declared steps: where the claimant goes to actually do the thing. */
  actionUrl?: string;
  /** True when this step is confirmed by the claimant rather than checked by us. */
  selfDeclared?: boolean;
}
