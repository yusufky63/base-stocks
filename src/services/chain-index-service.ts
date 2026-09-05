import type { Address, Hash } from "viem";
import { getRepos } from "@/db/repositories";
import type { IndexedTransfer, WalletIndexRow } from "@/db/index-repos";
import { cached } from "@/lib/cache";
import { metrics } from "@/lib/http";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { b20AssetAbi } from "@/lib/b20/abi";
import type { TimelineTransfer } from "@/lib/activity/timeline";
import { getAssets } from "./b20-asset-service";
import { blockTimes } from "./receipt-service";
import { reconcileEarn } from "./earn-reconcile-service";

/**
 * The app's own index of tokenized-stock transfers, so the timeline's cost stops growing with
 * the number of wallets.
 *
 * Before: every timeline read scanned 120k blocks of `Transfer` logs for that one wallet — two
 * calls per 10k-block chunk, per wallet, repeated after every cache window. A thousand wallets
 * was a thousand scans. Now a wallet is scanned once, when it first appears (`registerWallet`),
 * and from then on one sweep reads every stock's transfers for a block range a single time and
 * keeps the rows that touch an indexed wallet (`sweepTransfers`). A timeline read is a table
 * lookup plus one bounded look at the blocks mined since the last sweep, shared by everyone.
 */
const LOOKBACK_BLOCKS = 120_000n;
const CHUNK = 10_000n;
const CURSOR_KEY = "index:transfers";
const DEFAULT_MAX_BLOCKS = 100_000n;
/** The unswept tail a timeline read may look at directly; anything older waits for the sweep. */
const TAIL_MAX_BLOCKS = 5_000n;
/** Block times fetched per sweep at most; rows past that keep their block number and get a time later. */
const MAX_BLOCK_TIMES = 600;

const TRANSFER_EVENT = b20AssetAbi.find((x) => x.type === "event" && x.name === "Transfer")! as (typeof b20AssetAbi)[number] & { type: "event" };

type RawLog = { address: Address; args: unknown; transactionHash: Hash | null; blockNumber: bigint | null; logIndex: number | null };

function toRows(logs: RawLog[]): IndexedTransfer[] {
  const out: IndexedTransfer[] = [];
  for (const log of logs) {
    const args = log.args as { from?: Address; to?: Address; value?: bigint };
    if (!args.from || !args.to || args.value === undefined || !log.transactionHash || log.blockNumber === null || log.logIndex === null) continue;
    out.push({ txHash: log.transactionHash, logIndex: log.logIndex, blockNumber: Number(log.blockNumber), token: log.address, from: args.from, to: args.to, value: args.value.toString() });
  }
  return out;
}

async function stockAddresses(): Promise<Address[]> {
  return (await getAssets()).map((a) => a.address);
}

async function withTimes(rows: IndexedTransfer[]): Promise<IndexedTransfer[]> {
  const blocks = [...new Set(rows.map((r) => r.blockNumber))].slice(0, MAX_BLOCK_TIMES);
  const times = await blockTimes(blocks).catch(() => new Map<number, number>());
  return rows.map((r) => ({ ...r, blockTime: times.get(r.blockNumber) }));
}

/** One wallet's transfers over a block range, read from the chain (two calls per chunk, in and out). */
async function scanWallet(wallet: Address, tokens: Address[], fromBlock: bigint, toBlock: bigint): Promise<IndexedTransfer[]> {
  const client = getServerPublicClient();
  const rows: IndexedTransfer[] = [];
  for (let start = fromBlock; start <= toBlock; start += CHUNK + 1n) {
    const end = start + CHUNK > toBlock ? toBlock : start + CHUNK;
    const [sent, received] = await Promise.all([
      client.getLogs({ address: tokens, event: TRANSFER_EVENT, args: { from: wallet }, fromBlock: start, toBlock: end }),
      client.getLogs({ address: tokens, event: TRANSFER_EVENT, args: { to: wallet }, fromBlock: start, toBlock: end }),
    ]);
    rows.push(...toRows([...sent, ...received] as RawLog[]));
  }
  // A self-transfer appears in both lists.
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.txHash.toLowerCase()}:${r.logIndex}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Makes a wallet part of the index: its recent history is read once from the chain and kept, and
 * its Earn records are reconciled once from the venues' events. Later reads cost a table lookup.
 * Cached per wallet so a page that polls never re-checks the registry.
 */
export async function registerWallet(owner: Address): Promise<WalletIndexRow> {
  const key = owner.toLowerCase();
  return cached(`index:wallet:${key}`, { ttlMs: 10 * 60_000, staleMs: 60 * 60_000 }, async () => {
    const repos = getRepos();
    const existing = await repos.walletIndex.get(owner).catch(() => null);
    if (existing) return existing;
    const client = getServerPublicClient();
    const head = await client.getBlockNumber();
    const from = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
    const tokens = await stockAddresses();
    let rows: IndexedTransfer[] = [];
    try {
      rows = await withTimes(await scanWallet(owner, tokens, from, head));
    } catch (err) {
      // A public RPC's range limit: the wallet is still registered; the sweep covers it from here on.
      metrics.count("index.backfill", false, err instanceof Error ? err.message : String(err));
    }
    if (rows.length > 0) await repos.chainTransfers.insertMany(rows).catch(() => 0);
    const row: WalletIndexRow = { wallet: key as Address, indexedFrom: Number(from), indexedTo: Number(head), createdAt: Date.now() };
    await repos.walletIndex.upsert(row).catch(() => undefined);
    await reconcileEarn([owner], from, head).catch((err) => metrics.count("index.earn", false, err instanceof Error ? err.message : String(err)));
    metrics.count("index.backfill", true, `${rows.length} transfers`);
    return row;
  });
}

export interface IndexSweepResult {
  fromBlock: string;
  toBlock: string;
  head: string;
  wallets: number;
  found: number;
  added: number;
  more: boolean;
}

/**
 * The cursor-driven sweep: every stock's transfers for the blocks mined since the last sweep,
 * read once, keeping what touches an indexed wallet. One `getLogs` per 10k-block chunk however
 * many wallets there are.
 */
export async function sweepTransfers(opts: { maxBlocks?: bigint } = {}): Promise<IndexSweepResult> {
  const repos = getRepos();
  const client = getServerPublicClient();
  const head = await client.getBlockNumber();
  const wallets = new Set((await repos.walletIndex.listWallets().catch(() => [])).map((w) => w.toLowerCase()));
  const cursor = await repos.cursors.get(CURSOR_KEY).catch(() => null);
  // First run: the wallets' own backfills cover history; the sweep only has to keep up from here.
  const from = cursor !== null ? BigInt(cursor) + 1n : head > 1_000n ? head - 1_000n : 0n;
  const max = opts.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const to = from + max - 1n < head ? from + max - 1n : head;
  const base = { fromBlock: from.toString(), toBlock: to.toString(), head: head.toString(), wallets: wallets.size };
  if (from > head) return { ...base, found: 0, added: 0, more: false };
  if (wallets.size === 0) {
    await repos.cursors.set(CURSOR_KEY, Number(to)).catch(() => undefined);
    return { ...base, found: 0, added: 0, more: to < head };
  }
  const tokens = await stockAddresses();
  const kept: IndexedTransfer[] = [];
  let found = 0;
  for (let start = from; start <= to; start += CHUNK + 1n) {
    const end = start + CHUNK > to ? to : start + CHUNK;
    const logs = await client.getLogs({ address: tokens, event: TRANSFER_EVENT, fromBlock: start, toBlock: end });
    const rows = toRows(logs as RawLog[]);
    found += rows.length;
    kept.push(...rows.filter((r) => wallets.has(r.from.toLowerCase()) || wallets.has(r.to.toLowerCase())));
  }
  const added = kept.length > 0 ? await repos.chainTransfers.insertMany(await withTimes(kept)) : 0;
  await repos.cursors.set(CURSOR_KEY, Number(to)).catch(() => undefined);
  metrics.count("index.sweep", true, `${found} transfers seen, ${added} kept`);
  return { ...base, found, added, more: to < head };
}

/**
 * The blocks the sweep has not reached yet, read once for everyone and cached briefly: a
 * transfer mined a minute ago shows up without waiting for the next sweep.
 */
async function tailTransfers(): Promise<IndexedTransfer[]> {
  return cached("index:tail", { ttlMs: 45_000, staleMs: 3 * 60_000, shared: true }, async () => {
    const repos = getRepos();
    const client = getServerPublicClient();
    const head = await client.getBlockNumber();
    const cursor = await repos.cursors.get(CURSOR_KEY).catch(() => null);
    let from = cursor !== null ? BigInt(cursor) + 1n : head - 500n;
    if (head - from > TAIL_MAX_BLOCKS) from = head - TAIL_MAX_BLOCKS;
    if (from > head) return [];
    const tokens = await stockAddresses();
    const rows: IndexedTransfer[] = [];
    for (let start = from; start <= head; start += CHUNK + 1n) {
      const end = start + CHUNK > head ? head : start + CHUNK;
      const logs = await client.getLogs({ address: tokens, event: TRANSFER_EVENT, fromBlock: start, toBlock: end });
      rows.push(...toRows(logs as RawLog[]));
    }
    return withTimes(rows);
  });
}

/** A wallet's transfers for the timeline: the index plus the unswept tail. */
export async function transfersForWallet(owner: Address): Promise<TimelineTransfer[]> {
  const repos = getRepos();
  await registerWallet(owner).catch((err) => metrics.count("index.register", false, err instanceof Error ? err.message : String(err)));
  const w = owner.toLowerCase();
  const [indexed, tail] = await Promise.all([repos.chainTransfers.listByWallet(owner).catch(() => [] as IndexedTransfer[]), tailTransfers().catch(() => [] as IndexedTransfer[])]);
  const seen = new Set<string>();
  const out: TimelineTransfer[] = [];
  for (const r of [...indexed, ...tail.filter((t) => t.from.toLowerCase() === w || t.to.toLowerCase() === w)]) {
    const k = `${r.txHash.toLowerCase()}:${r.logIndex}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ txHash: r.txHash, blockNumber: BigInt(r.blockNumber), asset: r.token, from: r.from, to: r.to, value: BigInt(r.value), timestamp: r.blockTime });
  }
  return out;
}
