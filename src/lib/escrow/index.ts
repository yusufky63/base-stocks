import { encodeAbiParameters, keccak256, parseSignature, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BASE_CHAIN_ID } from "@/config/chain";

/**
 * BStocks GiftEscrow on Base mainnet (contracts/src/GiftEscrow.sol). Ownerless: it can only
 * pay out to a claim-signed recipient or back to the sender.
 *
 * This is the contract NEW gifts are created in. A gift record remembers the escrow it was
 * locked in (`GiftRecord.escrowAddress`), so the claim page, the reclaim button and every
 * receipt check talk to that contract even after this constant moves to a redeployment; use
 * `escrowAddressOf(gift)` for anything that touches an existing gift, and this constant only
 * when creating one.
 *
 * A claim link is `/gifts/claim/<giftDbId>#k=<ephemeral private key>`. The fragment never
 * reaches any server; the onchain gift id is derived from the ephemeral ADDRESS, so the claim
 * page can locate the gift from the secret alone. Whoever holds the link controls the gift.
 */
/** The escrow new gifts use: V2, deployed 2026-09-13 (zero-recipient check, single-use claim keys). V1 stays claimable at its own address. */
export const GIFT_ESCROW_ADDRESS: Address = "0x59E4C2C5AfbDae22A09566EB69f283c7f884EB23";

/**
 * Every escrow this app has ever created gifts in, oldest first. The first deployment
 * (2026-09-03, tx 0x0b54a2d9937fb29b71490641442d1d1732abaad4d8aec90c0b5a58940fa903b0) predates
 * the `escrow_address` column, so a record without one is a gift in that contract; gifts still
 * locked there have to stay claimable and reclaimable after the contract is replaced.
 */
export const LEGACY_GIFT_ESCROW_ADDRESSES: readonly Address[] = ["0x8D9fE4b3Ab9BecbE1181d15d51FB9724561C7f55"];

/** The escrow a gift lives in: the one stored on the record, else the original deployment. */
export function escrowAddressOf(gift: { escrowAddress?: Address | null }): Address {
  return gift.escrowAddress ?? LEGACY_GIFT_ESCROW_ADDRESSES[0]!;
}

/** True for the current escrow and every legacy one; anything else is not ours and is never trusted. */
export function isKnownEscrow(address: string): boolean {
  const a = address.toLowerCase();
  return GIFT_ESCROW_ADDRESS.toLowerCase() === a || LEGACY_GIFT_ESCROW_ADDRESSES.some((x) => x.toLowerCase() === a);
}

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

/**
 * The EIP-712 domain the deployed contracts fix in their constructor, for the escrow a gift
 * actually lives in. The product went by BaseStocks for a while, but the escrow's `DOMAIN_SEPARATOR` was
 * computed from "BStocks GiftEscrow" on the day it was deployed and an immutable cannot follow a
 * rename: signing under any other name makes `ecrecover` return a stranger and every claim revert
 * with BadSignature. The verifying contract is part of the separator too, which is why this is a
 * function of the address rather than a constant: a claim signed for the old escrow is worthless
 * at the new one. `link.test.ts` asserts the digest against the contract's own formula so neither
 * the name nor the address can drift again.
 */
export const claimDomain = (verifyingContract: Address) => ({ name: "BStocks GiftEscrow", version: "1", chainId: BASE_CHAIN_ID, verifyingContract }) as const;
export const CLAIM_TYPES = { Claim: [{ name: "giftId", type: "bytes32" }, { name: "recipient", type: "address" }] } as const;

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

/**
 * Signs (giftId, recipient) with the link secret for the escrow holding the gift; that contract
 * recovers the claim key from it. `escrow` is the gift's own (`escrowAddressOf`), never the
 * constant: the domain binds the signature to one deployment.
 */
export async function signClaim(privateKey: Hex, escrow: Address, escrowId: Hex, recipient: Address): Promise<{ v: number; r: Hex; s: Hex; claimKey: Address }> {
  const account = privateKeyToAccount(privateKey);
  const signature = await account.signTypedData({ domain: claimDomain(escrow), types: CLAIM_TYPES, primaryType: "Claim", message: { giftId: escrowId, recipient } });
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
