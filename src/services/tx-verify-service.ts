import { decodeEventLog, type Abi, type Address, type Hash, type Hex } from "viem";
import type { GiftRecord } from "@/domain/gift";
import type { PoolLeg, PoolRecord } from "@/domain/pool";
import { getRepos } from "@/db/repositories";
import { cached } from "@/lib/cache";
import { metrics } from "@/lib/http";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { USDC_ADDRESS } from "@/config/chain";
import { escrowAddressOf, giftEscrowAbi, isKnownEscrow } from "@/lib/escrow";
import { giftPoolAbi, isKnownPoolContract, poolContractOf } from "@/lib/pool";
import { LP_MANAGER_INFO } from "@/lib/earn/lp-managers";
import { findEvent, initiatedBy, tokenMoves, touches, tradeFacts, type ReceiptLog, type TokenMove } from "@/lib/chain/receipt-checks";
import { AAVE_SUPPLY, AAVE_WITHDRAW, COMET_SUPPLY, COMET_WITHDRAW, ERC4626_DEPOSIT, ERC4626_WITHDRAW, decodeVenueEvent } from "@/lib/earn/venue-events";
import { earnVenues } from "./earn-reconcile-service";
import { blockTimes } from "./receipt-service";

/**
 * The chain's answer to a record the app is asked to write.
 *
 * The write routes used to take the browser's word for it: any caller could file a trade, a gift
 * or a deposit for any wallet with any figure. Now a record is accepted only when the receipt it
 * names shows the thing it claims — the stock arriving in that wallet, the escrow emitting
 * `GiftCreated` for that id, the pool emitting `PoolClaimed` for that recipient — and the
 * amounts the record keeps are read from the receipt where the receipt has them. Who sent the
 * transaction is never the test (a relayer or a bundler may have); what moved is.
 *
 * Every verdict that succeeds also stores the receipt, so the timeline and the statistics never
 * ask the chain about that hash again.
 */
export type Verdict<T = object> = ({ ok: true; blockNumber: number; blockTime?: number } & T) | { ok: false; state: "pending" | "reverted" | "mismatch"; reason: string };

interface Receipt {
  status: "success" | "reverted";
  blockNumber: number;
  logs: ReceiptLog[];
  /** The account that sent the transaction; absent on receipts cached before it was kept. */
  from?: Address;
}

const RECEIPT_ATTEMPTS = 3;
const RECEIPT_RETRY_MS = 1_200;

/** A mined receipt with its logs; a hash the RPC does not know yet is retried briefly, then reported pending. */
async function fetchReceipt(hash: Hash): Promise<Receipt | null> {
  const key = `receipt:full:${hash.toLowerCase()}`;
  return cached(key, { ttlMs: 10 * 60_000, staleMs: 60 * 60_000 }, async () => {
    const client = getServerPublicClient();
    for (let i = 0; i < RECEIPT_ATTEMPTS; i++) {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return {
          status: r.status === "success" ? ("success" as const) : ("reverted" as const),
          blockNumber: Number(r.blockNumber),
          from: r.from,
          logs: r.logs.map((l) => ({ address: l.address, topics: l.topics as Hex[], data: l.data, logIndex: l.logIndex })),
        };
      } catch {
        if (i < RECEIPT_ATTEMPTS - 1) await new Promise((res) => setTimeout(res, RECEIPT_RETRY_MS));
      }
    }
    throw new Error("pending");
  }).catch(() => null);
}

async function settled(hash: Hash, receipt: Receipt): Promise<{ blockNumber: number; blockTime?: number }> {
  const times = await blockTimes([receipt.blockNumber]).catch(() => new Map<number, number>());
  const blockTime = times.get(receipt.blockNumber);
  await getRepos()
    .receipts.putMany([{ txHash: hash, status: receipt.status, blockNumber: receipt.blockNumber, blockTime }])
    .catch(() => undefined);
  return { blockNumber: receipt.blockNumber, blockTime };
}

/** Receipt or a verdict explaining why there is none to read. */
async function receiptOrVerdict(hash: Hash): Promise<{ receipt: Receipt } | { verdict: Verdict<never> }> {
  const receipt = await fetchReceipt(hash);
  if (!receipt) return { verdict: { ok: false, state: "pending", reason: "The transaction is not mined yet, or this RPC does not know it." } };
  if (receipt.status !== "success") {
    await settled(hash, receipt);
    return { verdict: { ok: false, state: "reverted", reason: "The transaction reverted onchain." } };
  }
  return { receipt };
}

function refuse(reason: string): Verdict<never> {
  metrics.count("verify.mismatch", false, reason);
  return { ok: false, state: "mismatch", reason };
}

/* --------------------------------- trades --------------------------------- */

export interface TradeFacts {
  /** Stock units that moved, from the receipt. */
  assetAmount: bigint;
  /** USDC that settled, from the receipt; null for a buy paid in ETH. */
  usdcAmount: bigint | null;
  /** Whether the owner is the account that sent the transaction (see `initiatedBy`). */
  initiatedByOwner: boolean;
}

export async function verifyTrade(input: { txHash: Hash; owner: Address; assetAddress: Address; side: "buy" | "sell"; recipient?: Address }): Promise<Verdict<TradeFacts>> {
  const got = await receiptOrVerdict(input.txHash);
  if ("verdict" in got) return got.verdict;
  const facts = tradeFacts(got.receipt.logs, { owner: input.owner, assetAddress: input.assetAddress, side: input.side, recipient: input.recipient, usdc: USDC_ADDRESS });
  if (!facts.ok) return refuse(facts.reason);
  return { ok: true, ...(await settled(input.txHash, got.receipt)), assetAmount: facts.assetAmount, usdcAmount: facts.usdcAmount, initiatedByOwner: initiatedBy(got.receipt.logs, got.receipt.from, input.owner) };
}

/* --------------------------------- gifts ---------------------------------- */

const lower = (s: string) => s.toLowerCase();

export interface GiftFacts {
  /** Raw units the chain shows moving (or locked in the escrow). */
  amount: bigint;
  /** Claim links: the escrow's own expiry (unix ms), read from `GiftCreated`; the draft's figure is never trusted. */
  expiresAt?: number;
}

/**
 * The escrow a claim-link gift's events must come from: the record's own contract, which has to be
 * one of ours. A `GiftCreated` from any other address, however well formed, proves nothing.
 */
function escrowFor(gift: { escrowAddress?: Address | null }): Address | null {
  const at = escrowAddressOf(gift);
  return isKnownEscrow(at) ? at : null;
}

/** The funding or sending transaction of a gift, by kind. Returns the amount the chain shows. */
export async function verifyGift(gift: Pick<GiftRecord, "kind" | "sender" | "recipient" | "assetAddress" | "escrowId" | "escrowAddress">, txHash: Hash): Promise<Verdict<GiftFacts>> {
  const got = await receiptOrVerdict(txHash);
  if ("verdict" in got) return got.verdict;
  const logs = got.receipt.logs;
  if (gift.kind === "claim-link") {
    if (!gift.escrowId) return refuse("The gift has no escrow id to match.");
    const escrow = escrowFor(gift);
    if (!escrow) return refuse("The gift names an escrow contract this app does not know.");
    const ev = findEvent<{ id: Hex; sender: Address; token: Address; amount: bigint; expiry: bigint }>(logs, giftEscrowAbi as Abi, escrow, "GiftCreated", (a) => lower(a.id) === lower(gift.escrowId!));
    if (!ev) return refuse("No GiftCreated for this escrow id in that transaction.");
    if (lower(ev.sender) !== lower(gift.sender)) return refuse("The escrow names a different sender.");
    if (lower(ev.token) !== lower(gift.assetAddress)) return refuse("The escrow holds a different stock.");
    return { ok: true, ...(await settled(txHash, got.receipt)), amount: ev.amount, expiresAt: Number(ev.expiry) * 1000 };
  }
  const moves = tokenMoves(logs, gift.assetAddress);
  if (gift.kind === "send-existing") {
    const move = moves.find((m) => lower(m.from) === lower(gift.sender) && lower(m.to) === lower(gift.recipient));
    if (!move) return refuse("That transaction does not move this stock from the sender to the recipient.");
    return { ok: true, ...(await settled(txHash, got.receipt)), amount: move.value };
  }
  // buy-for-recipient: the stock arrived in the recipient's wallet; the buyer paid the route.
  const received = moves.filter((m) => lower(m.to) === lower(gift.recipient)).reduce((s, m) => s + m.value, 0n) - moves.filter((m) => lower(m.from) === lower(gift.recipient)).reduce((s, m) => s + m.value, 0n);
  if (received <= 0n) return refuse("The stock did not arrive in the recipient's wallet in that transaction.");
  return { ok: true, ...(await settled(txHash, got.receipt)), amount: received };
}

/** The claim of a claim-link gift: who the escrow paid, from its own log. */
export async function verifyGiftClaim(gift: Pick<GiftRecord, "escrowId" | "escrowAddress">, claimTx: Hash): Promise<Verdict<{ recipient: Address; amount: bigint }>> {
  if (!gift.escrowId) return refuse("The gift has no escrow id to match.");
  const escrow = escrowFor(gift);
  if (!escrow) return refuse("The gift names an escrow contract this app does not know.");
  const got = await receiptOrVerdict(claimTx);
  if ("verdict" in got) return got.verdict;
  const ev = findEvent<{ id: Hex; recipient: Address; token: Address; amount: bigint }>(got.receipt.logs, giftEscrowAbi as Abi, escrow, "GiftClaimed", (a) => lower(a.id) === lower(gift.escrowId!));
  if (!ev) return refuse("No GiftClaimed for this escrow id in that transaction.");
  return { ok: true, ...(await settled(claimTx, got.receipt)), recipient: ev.recipient, amount: ev.amount };
}

/** The sender taking an unclaimed gift back. */
export async function verifyGiftReclaim(gift: Pick<GiftRecord, "escrowId" | "sender" | "escrowAddress">, txHash: Hash): Promise<Verdict> {
  if (!gift.escrowId) return refuse("The gift has no escrow id to match.");
  const escrow = escrowFor(gift);
  if (!escrow) return refuse("The gift names an escrow contract this app does not know.");
  const got = await receiptOrVerdict(txHash);
  if ("verdict" in got) return got.verdict;
  const ev = findEvent<{ id: Hex; sender: Address }>(got.receipt.logs, giftEscrowAbi as Abi, escrow, "GiftReclaimed", (a) => lower(a.id) === lower(gift.escrowId!));
  if (!ev) return refuse("No GiftReclaimed for this escrow id in that transaction.");
  if (lower(ev.sender) !== lower(gift.sender)) return refuse("The escrow refunded a different sender.");
  return { ok: true, ...(await settled(txHash, got.receipt)) };
}

/* ---------------------------------- earn ---------------------------------- */

const LP_PROVIDERS = new Set(["uniswap", "aerodrome"]);

/**
 * A lending deposit or withdrawal is proven by the venue's own event naming the wallet; a
 * liquidity action by the position manager having acted and the wallet's tokens having moved.
 */
export interface EarnFacts {
  /** The venue's own figure for a lending action; null for a liquidity action, which the app prices from `moves`. */
  amount: bigint | null;
  /** Whether the owner is the account that sent the transaction (see `initiatedBy`). */
  initiatedByOwner: boolean;
  /** For a liquidity action: every ERC-20 transfer into or out of the owner's wallet, so the record's value can be bounded. */
  moves: TokenMove[];
}

export async function verifyEarn(input: { txHash: Hash; owner: Address; provider: string; action: "deposit" | "withdraw" | "collect" }): Promise<Verdict<EarnFacts>> {
  const got = await receiptOrVerdict(input.txHash);
  if ("verdict" in got) return got.verdict;
  const logs = got.receipt.logs;
  const initiatedByOwner = initiatedBy(logs, got.receipt.from, input.owner);
  if (LP_PROVIDERS.has(input.provider)) {
    const managers = LP_MANAGER_INFO.filter((m) => m.provider === input.provider).map((m) => m.npm);
    if (!touches(logs, managers)) return refuse("No position manager of that venue acted in that transaction.");
    const mine = tokenMoves(logs).filter((m) => lower(m.from) === lower(input.owner) || lower(m.to) === lower(input.owner));
    if (mine.length === 0) return refuse("None of that wallet's tokens moved in that transaction.");
    return { ok: true, ...(await settled(input.txHash, got.receipt)), amount: null, initiatedByOwner, moves: mine };
  }
  if (input.action === "collect") return refuse("Only liquidity positions collect fees.");
  const venues = (await earnVenues()).filter((v) => v.provider === input.provider);
  if (venues.length === 0) return refuse("Unknown Earn venue.");
  for (const venue of venues) {
    const [abi, name] = venue.kind === "aave" ? (input.action === "deposit" ? [AAVE_SUPPLY, "Supply"] : [AAVE_WITHDRAW, "Withdraw"]) : venue.kind === "erc4626" ? (input.action === "deposit" ? [ERC4626_DEPOSIT, "Deposit"] : [ERC4626_WITHDRAW, "Withdraw"]) : input.action === "deposit" ? [COMET_SUPPLY, "Supply"] : [COMET_WITHDRAW, "Withdraw"];
    const args = findEvent<Record<string, unknown>>(logs, [abi] as unknown as Abi, venue.address, name, (a) => {
      const ev = decodeVenueEvent(venue.kind, input.action as "deposit" | "withdraw", a, { txHash: input.txHash, blockNumber: BigInt(got.receipt.blockNumber), logIndex: 0 });
      return !!ev && lower(ev.wallet) === lower(input.owner);
    });
    if (args) {
      const ev = decodeVenueEvent(venue.kind, input.action as "deposit" | "withdraw", args, { txHash: input.txHash, blockNumber: BigInt(got.receipt.blockNumber), logIndex: 0 })!;
      return { ok: true, ...(await settled(input.txHash, got.receipt)), amount: ev.amount, initiatedByOwner, moves: [] };
    }
  }
  return refuse("That venue did not record this wallet in that transaction.");
}

/* ---------------------------------- pools --------------------------------- */

/**
 * What the chain says a pool is. The record the browser filed carried the creator's intent; the
 * contract's events carry what was actually locked, and the record is overwritten with these.
 */
export interface PoolCreateFacts {
  gate: Address;
  slots: number;
  /** Unix ms. */
  expiry: number;
  /** Unix ms; 0 when the creator kept the right to cancel at once. */
  lockedUntil: number;
  /** One `PoolLeg` event per stock, in emission order, which is the contract's leg order. */
  legs: PoolLeg[];
}

/**
 * The contract a pool's events must come from: the record's own, which has to be one of ours. A
 * pool that predates the column lives in the first deployment; the current address only matters
 * for pools created against it.
 */
function poolContractFor(pool: { contractAddress?: Address | null }): Address | null {
  const at = poolContractOf(pool);
  return isKnownPoolContract(at) ? at : null;
}

export async function verifyPoolCreate(pool: Pick<PoolRecord, "onchainId" | "creator" | "contractAddress">, txHash: Hash): Promise<Verdict<PoolCreateFacts>> {
  const at = poolContractFor(pool);
  if (!at) return refuse("The pool names a contract this app does not know.");
  const got = await receiptOrVerdict(txHash);
  if ("verdict" in got) return got.verdict;
  const ev = findEvent<{ id: Hex; creator: Address; gate: Address; slots: number | bigint; expiry: bigint; lockedUntil: bigint }>(got.receipt.logs, giftPoolAbi as Abi, at, "PoolCreated", (a) => lower(a.id) === lower(pool.onchainId));
  if (!ev) return refuse("No PoolCreated for this pool in that transaction.");
  if (lower(ev.creator) !== lower(pool.creator)) return refuse("The pool was created by a different wallet.");
  const legs = poolLegEvents(got.receipt.logs, pool.onchainId, at);
  if (legs.length === 0) return refuse("The pool was created without any stock in it.");
  return {
    ok: true,
    ...(await settled(txHash, got.receipt)),
    gate: ev.gate,
    slots: Number(ev.slots),
    expiry: Number(ev.expiry) * 1000,
    lockedUntil: Number(ev.lockedUntil) * 1000,
    legs,
  };
}

/** Every `PoolLeg` the contract emitted for this pool, in order. `findEvent` stops at the first match, so this walks the logs itself. */
function poolLegEvents(logs: readonly ReceiptLog[], onchainId: Hex, contract: Address): PoolLeg[] {
  const at = lower(contract);
  const out: PoolLeg[] = [];
  for (const log of logs) {
    if (lower(log.address) !== at) continue;
    try {
      const d = decodeEventLog({ abi: giftPoolAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (d.eventName !== "PoolLeg") continue;
      const a = d.args as { id: Hex; token: Address; amountPerClaim: bigint };
      if (lower(a.id) !== lower(onchainId)) continue;
      out.push({ token: a.token, amountPerClaim: a.amountPerClaim.toString() });
    } catch {
      /* another event of the same contract */
    }
  }
  return out;
}

export async function verifyPoolClaim(pool: Pick<PoolRecord, "onchainId" | "contractAddress">, claimant: Address, txHash: Hash): Promise<Verdict> {
  const at = poolContractFor(pool);
  if (!at) return refuse("The pool names a contract this app does not know.");
  const got = await receiptOrVerdict(txHash);
  if ("verdict" in got) return got.verdict;
  const ev = findEvent<{ id: Hex; recipient: Address }>(got.receipt.logs, giftPoolAbi as Abi, at, "PoolClaimed", (a) => lower(a.id) === lower(pool.onchainId) && lower(a.recipient) === lower(claimant));
  if (!ev) return refuse("No PoolClaimed for this wallet and pool in that transaction.");
  return { ok: true, ...(await settled(txHash, got.receipt)) };
}

/** The creator closing a pool: `PoolCancelled` for this pool, by this creator. */
export async function verifyPoolCancel(pool: Pick<PoolRecord, "onchainId" | "creator" | "contractAddress">, txHash: Hash): Promise<Verdict> {
  const at = poolContractFor(pool);
  if (!at) return refuse("The pool names a contract this app does not know.");
  const got = await receiptOrVerdict(txHash);
  if ("verdict" in got) return got.verdict;
  const ev = findEvent<{ id: Hex; creator: Address }>(got.receipt.logs, giftPoolAbi as Abi, at, "PoolCancelled", (a) => lower(a.id) === lower(pool.onchainId));
  if (!ev) return refuse("No PoolCancelled for this pool in that transaction.");
  return { ok: true, ...(await settled(txHash, got.receipt)) };
}

/** Only the reason a caller may show; the state decides the HTTP answer. */
export function verdictError(v: Extract<Verdict, { ok: false }>): { code: "TX_PENDING" | "TX_REVERTED" | "TX_MISMATCH"; status: number; message: string } {
  if (v.state === "pending") return { code: "TX_PENDING", status: 409, message: v.reason };
  if (v.state === "reverted") return { code: "TX_REVERTED", status: 409, message: v.reason };
  return { code: "TX_MISMATCH", status: 400, message: v.reason };
}
