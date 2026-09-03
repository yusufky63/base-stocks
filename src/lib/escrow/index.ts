import { encodeAbiParameters, keccak256, parseSignature, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BASE_CHAIN_ID } from "@/config/chain";

/**
 * BStocks GiftEscrow on Base mainnet (contracts/src/GiftEscrow.sol, deployed 2026-09-03,
 * tx 0x0b54a2d9937fb29b71490641442d1d1732abaad4d8aec90c0b5a58940fa903b0). Ownerless: it can
 * only pay out to a claim-signed recipient or back to the sender.
 *
 * A claim link is `/gifts/claim/<giftDbId>#k=<ephemeral private key>`. The fragment never
 * reaches any server; the onchain gift id is derived from the ephemeral ADDRESS, so the claim
 * page can locate the gift from the secret alone. Whoever holds the link controls the gift.
 */
export const GIFT_ESCROW_ADDRESS: Address = "0x8D9fE4b3Ab9BecbE1181d15d51FB9724561C7f55";

/** Mirrors GiftEscrow.MAX_GIFT_DURATION. */
export const MAX_GIFT_DURATION_S = 90 * 24 * 3600;

export const giftEscrowAbi = [
  { type: "function", name: "create", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "claimKey", type: "address" }, { name: "expiry", type: "uint64" }, { name: "memoRef", type: "bytes32" }], outputs: [{ name: "id", type: "bytes32" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }, { name: "recipient", type: "address" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }], outputs: [] },
  { type: "function", name: "reclaim", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "gifts", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ name: "sender", type: "address" }, { name: "token", type: "address" }, { name: "expiry", type: "uint64" }, { name: "amount", type: "uint256" }] },
  { type: "function", name: "giftId", stateMutability: "pure", inputs: [{ name: "claimKey", type: "address" }], outputs: [{ type: "bytes32" }] },
  { type: "event", name: "GiftCreated", inputs: [{ name: "id", type: "bytes32", indexed: true }, { name: "sender", type: "address", indexed: true }, { name: "token", type: "address", indexed: true }, { name: "amount", type: "uint256" }, { name: "expiry", type: "uint64" }, { name: "memoRef", type: "bytes32" }] },
  { type: "event", name: "GiftClaimed", inputs: [{ name: "id", type: "bytes32", indexed: true }, { name: "recipient", type: "address", indexed: true }, { name: "token", type: "address", indexed: true }, { name: "amount", type: "uint256" }] },
  { type: "event", name: "GiftReclaimed", inputs: [{ name: "id", type: "bytes32", indexed: true }, { name: "sender", type: "address", indexed: true }, { name: "token", type: "address", indexed: true }, { name: "amount", type: "uint256" }] },
] as const;

const CLAIM_DOMAIN = { name: "BStocks GiftEscrow", version: "1", chainId: BASE_CHAIN_ID, verifyingContract: GIFT_ESCROW_ADDRESS } as const;
const CLAIM_TYPES = { Claim: [{ name: "giftId", type: "bytes32" }, { name: "recipient", type: "address" }] } as const;

/** Onchain gift id for a claim key: keccak256(abi.encode(claimKey)) — matches GiftEscrow.giftId. */
export function escrowIdFor(claimKey: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }], [claimKey]));
}

export interface ClaimSecret {
  privateKey: Hex;
  claimKey: Address;
  escrowId: Hex;
}

/** Fresh ephemeral key for one gift; the private half goes only into the share link's fragment. */
export function makeClaimSecret(): ClaimSecret {
  const privateKey = generatePrivateKey();
  const claimKey = privateKeyToAccount(privateKey).address;
  return { privateKey, claimKey, escrowId: escrowIdFor(claimKey) };
}

/** Signs (giftId, recipient) with the link secret; the contract recovers the claim key from it. */
export async function signClaim(privateKey: Hex, escrowId: Hex, recipient: Address): Promise<{ v: number; r: Hex; s: Hex; claimKey: Address }> {
  const account = privateKeyToAccount(privateKey);
  const signature = await account.signTypedData({ domain: CLAIM_DOMAIN, types: CLAIM_TYPES, primaryType: "Claim", message: { giftId: escrowId, recipient } });
  const { v, r, s } = parseSignature(signature);
  return { v: Number(v ?? 27n), r, s, claimKey: account.address };
}

/** Share-link fragment helpers. The key never leaves the URL fragment (browsers do not send it). */
export function claimPath(giftDbId: string, privateKey: Hex): string {
  return `/gifts/claim/${giftDbId}#k=${privateKey}`;
}

export function parseClaimFragment(hash: string): ClaimSecret | null {
  const m = /(?:^|[#&])k=(0x[0-9a-fA-F]{64})(?:&|$)/.exec(hash);
  if (!m) return null;
  try {
    const privateKey = m[1] as Hex;
    const claimKey = privateKeyToAccount(privateKey).address;
    return { privateKey, claimKey, escrowId: escrowIdFor(claimKey) };
  } catch {
    return null;
  }
}
