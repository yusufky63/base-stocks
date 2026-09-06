import { encodeAbiParameters, keccak256, parseSignature, stringToHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BASE_CHAIN_ID } from "@/config/chain";

/**
 * BaseStocks GiftPool (contracts/src/GiftPool.sol), deployed to Base mainnet 2026-09-04 at
 * `0xBD23ABB61D80B88DacB1Dc56DC2641e4Bfb76E10`, tx
 * 0x5e26536977c1ec333b05e9ad2547d0455897bbf2d55b61de0a33372015e86a6c, source verified on
 * Basescan. Ownerless: it can only pay a claimant their exact share or return the unclaimed
 * remainder to the creator. No admin, no pause, no upgrade, no fee, no token allowlist.
 *
 * The address comes from `NEXT_PUBLIC_GIFT_POOL_ADDRESS` rather than a constant so a preview or
 * a fork can point elsewhere; an unset value means "pools are not available here" and the app
 * hides the feature rather than pointing users at nothing.
 */
export const GIFT_POOL_ADDRESS = (process.env.NEXT_PUBLIC_GIFT_POOL_ADDRESS ?? "") as Address | "";

export function isPoolDeployed(): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(GIFT_POOL_ADDRESS) && GIFT_POOL_ADDRESS !== ZERO_ADDRESS;
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** Mirrors GiftPool.MAX_POOL_DURATION and MAX_LEGS. */
export const MAX_POOL_DURATION_S = 365 * 24 * 3600;
export const MAX_POOL_LEGS = 8;
/** Practical ceiling on slots: the create transaction stays one confirmation either way, but a
 *  pool this size is a campaign, not a gift, and the UI should say so. */
export const MAX_POOL_SLOTS = 10_000;
/** Steps a pool may ask for. Offchain only, so this is a usability limit, not a contract one. */
export const MAX_POOL_QUESTS = 8;

export const giftPoolAbi = [
  {
    type: "function",
    name: "create",
    stateMutability: "nonpayable",
    inputs: [
      { name: "salt", type: "bytes32" },
      { name: "gate", type: "address" },
      { name: "slots", type: "uint32" },
      { name: "expiry", type: "uint64" },
      { name: "lockedUntil", type: "uint64" },
      { name: "tokens", type: "address[]" },
      { name: "amountsPerClaim", type: "uint256[]" },
      { name: "memoRef", type: "bytes32" },
    ],
    outputs: [{ name: "id", type: "bytes32" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint64" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  { type: "function", name: "cancel", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  {
    type: "function",
    name: "withdrawLeg",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "legIndex", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "pools",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "creator", type: "address" },
      { name: "gate", type: "address" },
      { name: "slots", type: "uint32" },
      { name: "claimed", type: "uint32" },
      { name: "expiry", type: "uint64" },
      { name: "lockedUntil", type: "uint64" },
      { name: "cancelled", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "legsOf",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "amountPerClaim", type: "uint256" },
          { name: "withdrawn", type: "bool" },
        ],
      },
    ],
  },
  { type: "function", name: "remainingSlots", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "uint32" }] },
  {
    type: "function",
    name: "hasClaimed",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "claimant", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "poolId",
    stateMutability: "pure",
    inputs: [
      { name: "creator", type: "address" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "event",
    name: "PoolCreated",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "gate", type: "address", indexed: true },
      { name: "slots", type: "uint32" },
      { name: "expiry", type: "uint64" },
      { name: "lockedUntil", type: "uint64" },
      { name: "memoRef", type: "bytes32" },
    ],
  },
  {
    type: "event",
    name: "PoolLeg",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "amountPerClaim", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "PoolClaimed",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "index", type: "uint32" },
    ],
  },
  {
    type: "event",
    name: "PoolCancelled",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "creator", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "PoolWithdrawn",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "amount", type: "uint256" },
    ],
  },
] as const;

/* ------------------------------ ids and memos ------------------------------ */

/**
 * Salt for a pool, derived from the app-side id so the onchain id is reproducible from the
 * database row alone — no extra column can drift out of sync with the chain.
 */
export function poolSalt(appId: string): Hex {
  return keccak256(stringToHex(`bstocks:pool:salt:${appId}`));
}

/** Compact bytes32 reconciliation memo (never a human message). */
export function poolMemo(appId: string): Hex {
  return keccak256(stringToHex(`bstocks:pool:${appId}`));
}

/** Onchain pool id: keccak256(abi.encode(creator, salt)) — matches GiftPool.poolId. */
export function poolIdFor(creator: Address, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [creator, salt]));
}

/** The onchain id a given creator's pool will have, known before the transaction is sent. */
export function onchainIdFor(creator: Address, appId: string): Hex {
  return poolIdFor(creator, poolSalt(appId));
}

/* ------------------------------ claim tickets ------------------------------ */

export const poolTicketDomain = (verifyingContract: Address) =>
  ({ name: "BaseStocks GiftPool", version: "1", chainId: BASE_CHAIN_ID, verifyingContract }) as const;

export const POOL_TICKET_TYPES = {
  Ticket: [
    { name: "poolId", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export interface ClaimTicket {
  deadline: string;
  v: number;
  r: Hex;
  s: Hex;
}

/**
 * Signs a claim ticket. Used in two places with the same code: the server's campaign signer
 * (after the quests verify), and the claimant's browser holding a link key.
 */
export async function signPoolTicket(privateKey: Hex, contract: Address, poolId: Hex, recipient: Address, deadline: bigint): Promise<ClaimTicket> {
  const account = privateKeyToAccount(privateKey);
  const signature = await account.signTypedData({
    domain: poolTicketDomain(contract),
    types: POOL_TICKET_TYPES,
    primaryType: "Ticket",
    message: { poolId, recipient, deadline },
  });
  const { v, r, s } = parseSignature(signature);
  return { deadline: deadline.toString(), v: Number(v ?? 27n), r, s };
}

/* ------------------------------- link secrets ------------------------------ */

export interface PoolLinkSecret {
  privateKey: Hex;
  /** The gate address stored onchain for a `link` pool. */
  gateAddress: Address;
}

/** Fresh ephemeral key for one link-gated pool; the private half lives only in the share link. */
export function makePoolLinkSecret(): PoolLinkSecret {
  const privateKey = generatePrivateKey();
  return { privateKey, gateAddress: privateKeyToAccount(privateKey).address };
}

/** Share path for a pool. For `link` pools the fragment carries the key; browsers never send it. */
export function poolPath(appId: string, privateKey?: Hex): string {
  return `/pools/${appId}${privateKey ? `#k=${privateKey}` : ""}`;
}

/** Reads a link key out of `window.location.hash`, if one is there and it is well formed. */
export function parsePoolFragment(hash: string): PoolLinkSecret | null {
  const m = /(?:^|[#&])k=(0x[0-9a-fA-F]{64})(?:&|$)/.exec(hash);
  if (!m) return null;
  try {
    const privateKey = m[1] as Hex;
    return { privateKey, gateAddress: privateKeyToAccount(privateKey).address };
  } catch {
    return null;
  }
}

/* --------------------------------- amounts -------------------------------- */

/**
 * Splits a total into `slots` equal shares WITHOUT leaving a remainder: the per-claim amount is
 * floored and the pool is funded with `perClaim × slots`, so the creator deposits slightly less
 * than the number they typed rather than the contract stranding dust. Returns both numbers so
 * the UI can show exactly what will be locked.
 */
export function splitIntoShares(totalRaw: bigint, slots: number): { perClaim: bigint; funded: bigint; dust: bigint } {
  if (slots <= 0) return { perClaim: 0n, funded: 0n, dust: totalRaw };
  const perClaim = totalRaw / BigInt(slots);
  const funded = perClaim * BigInt(slots);
  return { perClaim, funded, dust: totalRaw - funded };
}

/**
 * How many share units a dollar figure buys, for the pool creator typing in money rather than in
 * fractions of a share.
 *
 * The price quotes the raw token, while the amount the creator enters is in share units, so the
 * multiplier has to be undone on the way through — for a stock that has never split the two are the
 * same and this is a no-op, and for one that has, they are not. Returns an empty string rather than
 * a zero for anything it cannot answer: an unpriced stock, a blank field, a negative.
 */
export function sharesForUsd(usd: string | number, priceUsd: number | null | undefined, multiplier: string | bigint, wadPrecision: string | bigint, decimals: number): string {
  const n = typeof usd === "number" ? usd : Number(usd);
  if (!priceUsd || !Number.isFinite(n) || n <= 0) return "";
  const rawUnits = n / priceUsd;
  const shares = (rawUnits * Number(wadPrecision)) / Number(multiplier);
  if (!Number.isFinite(shares) || shares <= 0) return "";
  const fixed = shares.toFixed(Math.min(decimals, 8));
  // Dollars too small to reach one unit of precision round to zero, and "0" in the field is not an
  // amount — it is a wrong answer that looks like one. Say nothing instead.
  if (Number(fixed) === 0) return "";
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}
