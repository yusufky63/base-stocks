import type { Address, Hash, Hex } from "viem";
import type { B20AssetDTO } from "./asset";

export type GiftKind = "send-existing" | "buy-for-recipient" | "claim-link";
export type GiftStatus = "draft" | "submitted" | "confirmed" | "failed" | "claimed" | "reclaimed";

export interface GiftRecord {
  id: string;
  kind: GiftKind;
  sender: Address;
  recipient: Address;
  recipientBasename?: string;
  assetAddress: Address;
  rawAmount: string;
  /** Human message stored offchain only. */
  message?: string;
  /**
   * bytes32 memo derived from the gift id and passed to the contract call. It is emitted in the
   * onchain event for anyone reading the chain; the app itself matches records by escrow id and
   * transaction hash, never by reading the memo back.
   */
  memo: Hex;
  txHash?: Hash;
  status: GiftStatus;
  createdAt: number;
  /** Claim-link gifts: onchain escrow id (keccak of the ephemeral claim key). */
  escrowId?: Hex;
  /**
   * Claim-link gifts: the GiftEscrow contract the stock is locked in. Stamped by the server at
   * creation; absent on gifts that predate the column, which all live in the first deployment
   * (see `escrowAddressOf`). Every read, claim, reclaim and receipt check goes to this address.
   */
  escrowAddress?: Address;
  /** Claim-link gifts: unix ms after which only the sender can withdraw. */
  expiresAt?: number;
  /** Claim-link gifts: the claim transaction, once someone claimed. */
  claimTx?: Hash;
  /**
   * When the server matched the record's latest state to the chain. Unset means unproven: the
   * timeline shows it as pending and the statistics leave it out.
   */
  verifiedAt?: number;
  verifyNote?: string;
}

/** One side of a gift, as shown on the receipt, the claim page and the share cards. */
export interface GiftParty {
  address: Address;
  /** Forward-verified Basename, the one identity a viewer can trust. */
  basename: string | null;
  /** BaseStocks handle / display name, only when the profile is public. */
  handle: string | null;
  /**
   * The profile's display name, or null when it is hidden or reads like a brand ("Coinbase
   * Support"). Never shown without the Basename or the address beside it.
   */
  displayName: string | null;
  avatar: string | null;
  /** Has a BaseStocks profile, i.e. signed in here at least once. A Basename alone is not membership. */
  isMember: boolean;
}

/** Public receipt for a gift that was actually submitted; drafts are never exposed. */
export interface GiftReceipt {
  gift: GiftRecord;
  asset: B20AssetDTO | null;
  sender: GiftParty;
  recipient: GiftParty;
}

/** What the recipient resolver returns for a Basename or raw address. */
export interface ResolvedRecipient {
  address: Address;
  /** Forward-resolved from the input, or reverse-resolved (and forward-verified) from a raw address. */
  basename?: string;
  avatar?: string | null;
  /** Present when the recipient has signed in to BaseStocks. */
  profile?: { handle?: string; displayName?: string; isPublic: boolean; memberSince: number } | null;
}
