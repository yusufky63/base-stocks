import type { Address, Hash, Hex } from "viem";

export type GiftKind = "send-existing" | "buy-for-recipient";
export type GiftStatus = "draft" | "submitted" | "confirmed" | "failed";

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
  /** bytes32 reconciliation memo derived from the gift id. */
  memo: Hex;
  txHash?: Hash;
  status: GiftStatus;
  createdAt: number;
}

/** What the recipient resolver returns for a Basename or raw address. */
export interface ResolvedRecipient {
  address: Address;
  /** Forward-resolved from the input, or reverse-resolved (and forward-verified) from a raw address. */
  basename?: string;
  avatar?: string | null;
  /** Present when the recipient has signed in to BStocks. */
  profile?: { handle?: string; displayName?: string; isPublic: boolean; memberSince: number } | null;
}
