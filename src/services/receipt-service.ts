import type { Hash } from "viem";
import { getRepos, type ReceiptRow } from "@/db/repositories";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { peek, set as cacheSet } from "@/lib/cache";
import { metrics } from "@/lib/http";

/**
 * What became of a transaction, as the chain tells it. This is the one source of truth behind
 * "verified" in the activity timeline and in the platform statistics: an app record is a claim,
 * a receipt is the fact.
 *
 * A mined receipt never changes, so each hash is read from the chain once and then kept — in
 * process for the hot path and in `tx_receipts` so every serverless instance shares the answer.
 * Pending transactions are re-asked on the next look, never stored.
 */
export interface ReceiptState {
  status: "success" | "reverted" | "pending";
  blockNumber?: number;
  /** Unix seconds of the block, when known. */
  blockTime?: number;
}

const MINED = { ttlMs: 24 * 60 * 60_000, staleMs: 7 * 24 * 60 * 60_000 };
/** A hash that is not mined yet is asked again after a few seconds, not on every request in a burst. */
const PENDING = { ttlMs: 5_000, staleMs: 0 };
const CONCURRENCY = 6;

const key = (h: string) => `receipt:${h.toLowerCase()}`;
const blockKey = (n: number) => `block-time:${n}`;

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/** Unix seconds of a block. Blocks are immutable, so the answer is kept for as long as the cache lives. */
export async function blockTimes(blockNumbers: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const missing: number[] = [];
  for (const n of new Set(blockNumbers)) {
    const hit = peek<number>(blockKey(n));
    if (hit !== undefined) out.set(n, hit);
    else missing.push(n);
  }
  if (missing.length === 0) return out;
  const client = getServerPublicClient();
  await inBatches(missing, CONCURRENCY, async (n) => {
    try {
      const block = await client.getBlock({ blockNumber: BigInt(n) });
      const t = Number(block.timestamp);
      cacheSet(blockKey(n), t, MINED);
      out.set(n, t);
    } catch (err) {
      metrics.count("receipt.block", false, err instanceof Error ? err.message : String(err));
    }
  });
  return out;
}

/**
 * Receipt states for a set of hashes, keyed by lowercase hash. Every hash gets an answer: a
 * transaction the chain does not know (yet) is `pending`.
 */
export async function getReceiptStates(hashes: Hash[]): Promise<Map<string, ReceiptState>> {
  const out = new Map<string, ReceiptState>();
  const wanted = [...new Set(hashes.map((h) => h.toLowerCase()))].filter((h) => /^0x[0-9a-f]{64}$/.test(h)) as Hash[];
  if (wanted.length === 0) return out;

  // 1. This process has already looked.
  let missing: Hash[] = [];
  for (const h of wanted) {
    const hit = peek<ReceiptState>(key(h));
    if (hit) out.set(h, hit);
    else missing.push(h);
  }
  if (missing.length === 0) return out;

  // 2. Another instance has already looked.
  const repos = getRepos();
  const stored = await repos.receipts.getMany(missing).catch(() => [] as ReceiptRow[]);
  for (const r of stored) {
    const state: ReceiptState = { status: r.status, blockNumber: r.blockNumber, blockTime: r.blockTime };
    cacheSet(key(r.txHash), state, MINED);
    out.set(r.txHash.toLowerCase(), state);
  }
  missing = missing.filter((h) => !out.has(h));
  if (missing.length === 0) return out;

  // 3. Ask the chain, a few at a time, and keep what is mined.
  const client = getServerPublicClient();
  const mined: ReceiptRow[] = [];
  await inBatches(missing, CONCURRENCY, async (h) => {
    try {
      const r = await client.getTransactionReceipt({ hash: h });
      mined.push({ txHash: h, status: r.status === "success" ? "success" : "reverted", blockNumber: Number(r.blockNumber) });
    } catch {
      // Not mined, or unknown to this RPC: pending until the next look.
      const state: ReceiptState = { status: "pending" };
      cacheSet(key(h), state, PENDING);
      out.set(h, state);
    }
  });
  if (mined.length > 0) {
    const times = await blockTimes(mined.map((m) => m.blockNumber));
    for (const m of mined) {
      m.blockTime = times.get(m.blockNumber);
      const state: ReceiptState = { status: m.status, blockNumber: m.blockNumber, blockTime: m.blockTime };
      cacheSet(key(m.txHash), state, MINED);
      out.set(m.txHash.toLowerCase(), state);
    }
    await repos.receipts.putMany(mined).catch((err) => metrics.count("receipt.store", false, err instanceof Error ? err.message : String(err)));
  }
  return out;
}

/** One hash; the same answer `getReceiptStates` would give it. */
export async function getReceiptState(hash: Hash): Promise<ReceiptState> {
  return (await getReceiptStates([hash])).get(hash.toLowerCase()) ?? { status: "pending" };
}
