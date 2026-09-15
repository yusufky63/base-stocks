import type { Address, Hash } from "viem";
import { getRepos } from "@/db/repositories";
import type { IndexedTransfer, WalletIndexRow } from "@/db/index-repos";
import { cached } from "@/lib/cache";
import { metrics } from "@/lib/http";
import { getServerPublicClient, getLogPublicClient } from "@/lib/viem/server-client";
import { b20AssetAbi } from "@/lib/b20/abi";
import type { TimelineTransfer } from "@/lib/activity/timeline";
import { getAssets } from "./b20-asset-service";
import { blockTimes } from "./receipt-service";
import { EARN_SCAN_FLOOR_BLOCK, reconcileEarn } from "./earn-reconcile-service";

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
/**
 * How far back a wallet's own history is read, and how much of it per request.
 *
 * The first visit used to read the last 120k blocks (under three days on Base) and stop: a wallet
 * that bought in week one and opened Activity in week three saw its purchases arrive out of
 * nowhere as "received" rows with no cost behind them. The floor is now the block before the first
 * BStocks transaction, and the read is paced: each request extends the wallet's `indexedFrom`
 * backwards by up to `BACKFILL_STEP_BLOCKS` inside `BACKFILL_BUDGET_MS`, stores where it got to,
 * and the next request (rate-limited per wallet) continues from there until the floor is reached.
 */
const INDEX_FLOOR_BLOCK = EARN_SCAN_FLOOR_BLOCK;
const BACKFILL_STEP_BLOCKS = 120_000n;
const BACKFILL_BUDGET_MS = 8_000;
/** How often one wallet's backfill is continued at most; a page that polls every 45 s must not scan every 45 s. */
const BACKFILL_RETRY_MS = 2 * 60_000;
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

/**
 * A range an RPC refuses is halved and retried, down to a floor of 50 blocks (1rpc.io's cap).
 *
 * The floor used to be 1,000 blocks, sized for providers that cap the block range. What stops a
 * request today is the size of the answer: the stock tokens' transfers have grown dense enough
 * (every launchpad swap moves stock through the pool) that a 1,000-block window can hold 20k
 * logs, which Alchemy refuses as "response body exceeded the size limit" and CDP as "invalid
 * parameters", while 100 blocks answer fine everywhere. With the floor at 1,000 the sweep failed
 * the same chunk every 15 minutes and the cursor stood still for hours, reported as ok. Below the
 * floor the error stands and the caller decides; anything that is not a range or size complaint
 * is re-thrown.
 */
const MIN_CHUNK = 50n;

/**
 * How wide one sweep request is, and how long the whole sweep may take.
 *
 * The sweep used to read its whole allowance in a single `eth_getLogs`, so there was nothing to
 * interrupt: as the stocks got busier that one call outgrew the function's 60 s and the job started
 * answering 504 with the cursor unmoved, forever. Small chunks give the loop somewhere to stop, and
 * a budget that ends the run cleanly turns "too much to do" into partial progress rather than a
 * failure. Whatever is left is picked up fifteen minutes later, and `more` says so.
 *
 * 1,000 blocks is also the widest range CDP's node serves, so this width never triggers the
 * halving fallback either.
 */
const SWEEP_CHUNK = 1_000n;
const SWEEP_BUDGET_MS = 35_000;

function isRangeLimit(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /limited to|block range|range is too large|exceed|too many blocks|up to \d+ blocks|size limit|invalid parameters/i.test(m);
}

async function getLogsAdaptive<T>(from: bigint, to: bigint, read: (a: bigint, b: bigint) => Promise<T[]>): Promise<T[]> {
  try {
    return await read(from, to);
  } catch (err) {
    const span = to - from + 1n;
    if (!isRangeLimit(err) || span <= MIN_CHUNK) throw err;
    const mid = from + span / 2n - 1n;
    const [a, b] = [await getLogsAdaptive(from, mid, read), await getLogsAdaptive(mid + 1n, to, read)];
    return [...a, ...b];
  }
}

/**
 * One wallet's transfers over a block range, read from the chain (two calls per chunk, in and
 * out), newest chunk first so that what is read inside the budget is the most recent history.
 * Returns the rows and the oldest block actually covered; a budget that runs out leaves
 * `coveredFrom` above `fromBlock` and the caller continues from there next time.
 */
async function scanWallet(wallet: Address, tokens: Address[], fromBlock: bigint, toBlock: bigint, budgetMs = Number.POSITIVE_INFINITY): Promise<{ rows: IndexedTransfer[]; coveredFrom: bigint }> {
  const client = getLogPublicClient();
  const rows: IndexedTransfer[] = [];
  const startedAt = Date.now();
  let coveredFrom = toBlock + 1n;
  for (let end = toBlock; end >= fromBlock; end -= CHUNK + 1n) {
    // Checked before each chunk, never during: an in-flight request cannot be interrupted.
    if (Date.now() - startedAt > budgetMs) break;
    const start = end - CHUNK < fromBlock ? fromBlock : end - CHUNK;
    const [sent, received] = await Promise.all([
      getLogsAdaptive(start, end, (a, b) => client.getLogs({ address: tokens, event: TRANSFER_EVENT, args: { from: wallet }, fromBlock: a, toBlock: b })),
      getLogsAdaptive(start, end, (a, b) => client.getLogs({ address: tokens, event: TRANSFER_EVENT, args: { to: wallet }, fromBlock: a, toBlock: b })),
    ]);
    rows.push(...toRows([...sent, ...received] as RawLog[]));
    coveredFrom = start;
  }
  // A self-transfer appears in both lists.
  const seen = new Set<string>();
  return {
    rows: rows.filter((r) => {
      const k = `${r.txHash.toLowerCase()}:${r.logIndex}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
    coveredFrom,
  };
}

/**
 * Extend a wallet's indexed range backwards by one bounded step: scan `[max(floor, from - STEP),
 * from - 1]` inside the budget, keep the rows, reconcile the Earn records for the same blocks, and
 * store the new `indexedFrom`. Returns the updated row.
 */
async function backfillStep(row: WalletIndexRow, tokens: Address[]): Promise<WalletIndexRow> {
  const repos = getRepos();
  const to = BigInt(row.indexedFrom) - 1n;
  if (to < INDEX_FLOOR_BLOCK) return row;
  const from = to - BACKFILL_STEP_BLOCKS + 1n < INDEX_FLOOR_BLOCK ? INDEX_FLOOR_BLOCK : to - BACKFILL_STEP_BLOCKS + 1n;
  let coveredFrom = to + 1n;
  try {
    const scan = await scanWallet(row.wallet, tokens, from, to, BACKFILL_BUDGET_MS);
    coveredFrom = scan.coveredFrom;
    if (scan.rows.length > 0) await repos.chainTransfers.insertMany(await withTimes(scan.rows)).catch(() => 0);
    metrics.count("index.backfill", true, `${scan.rows.length} transfers, ${coveredFrom}..${to}`);
  } catch (err) {
    // A public RPC's range limit, or a timeout: keep what was read; the next request continues.
    metrics.count("index.backfill", false, err instanceof Error ? err.message : String(err));
  }
  if (coveredFrom > to) return row;
  // Earn records for the same blocks, so a deposit from the first week is not "pending" in week three.
  await reconcileEarn([row.wallet], coveredFrom, to).catch((err) => metrics.count("index.earn", false, err instanceof Error ? err.message : String(err)));
  const next: WalletIndexRow = { ...row, indexedFrom: Number(coveredFrom) };
  await repos.walletIndex.upsert(next).catch(() => undefined);
  return next;
}

/** Whether the wallet's history has been read all the way back to the floor. */
export function backfillComplete(row: Pick<WalletIndexRow, "indexedFrom">): boolean {
  return BigInt(row.indexedFrom) <= INDEX_FLOOR_BLOCK;
}

/**
 * Makes a wallet part of the index. On first sight the row is created at the head with nothing
 * covered, then the first backfill step runs inside this same request, so the most recent history
 * is there before the page renders; the sweep keeps the row current from `indexedTo` on, and later
 * requests walk `indexedFrom` back to the floor one step at a time. Cached per wallet so a page
 * that polls never re-checks the registry.
 */
export async function registerWallet(owner: Address): Promise<WalletIndexRow> {
  const key = owner.toLowerCase();
  return cached(`index:wallet:${key}`, { ttlMs: 10 * 60_000, staleMs: 60 * 60_000 }, async () => {
    const repos = getRepos();
    const existing = await repos.walletIndex.get(owner).catch(() => null);
    if (existing) return existing;
    const head = await getServerPublicClient().getBlockNumber();
    // Registered at the head with an empty range; the step below fills the recent past.
    const row: WalletIndexRow = { wallet: key as Address, indexedFrom: Number(head + 1n), indexedTo: Number(head), createdAt: Date.now() };
    await repos.walletIndex.upsert(row).catch(() => undefined);
    return backfillStep(row, await stockAddresses());
  });
}

/**
 * Continue a registered wallet's backfill towards the floor, at most once per `BACKFILL_RETRY_MS`
 * per wallet on this instance. Nothing to do once the floor is reached.
 */
async function continueBackfill(row: WalletIndexRow): Promise<WalletIndexRow> {
  if (backfillComplete(row)) return row;
  return cached(`index:backfill:${row.wallet.toLowerCase()}`, { ttlMs: BACKFILL_RETRY_MS }, async () => {
    // Another instance may have moved the cursor since this one's cached row was read.
    const fresh = (await getRepos().walletIndex.get(row.wallet).catch(() => null)) ?? row;
    if (backfillComplete(fresh)) return fresh;
    return backfillStep(fresh, await stockAddresses());
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
  // The log rotation, like the other readers: a provider that caps or bills wide log reads does
  // not lead it.
  const logClient = getLogPublicClient();
  const kept: IndexedTransfer[] = [];
  let found = 0;
  let covered = from - 1n;
  // The window narrows when a provider refuses it (too many logs for one answer) and stays narrow
  // for the rest of the run, so a dense stretch costs a few extra requests rather than the same
  // halving cascade on every chunk.
  let width = SWEEP_CHUNK;
  const startedAt = Date.now();
  let start = from;
  while (start <= to) {
    // Checked before the call, never during: an in-flight request cannot be interrupted, which is
    // why the chunk has to be small enough that one of them always fits in what is left.
    if (Date.now() - startedAt > SWEEP_BUDGET_MS) {
      metrics.count("index.sweep.budget", true, `stopped at ${covered}`);
      break;
    }
    const end = start + width - 1n > to ? to : start + width - 1n;
    let logs;
    try {
      logs = await logClient.getLogs({ address: tokens, event: TRANSFER_EVENT, fromBlock: start, toBlock: end });
    } catch (err) {
      if (!isRangeLimit(err)) throw err;
      if (width > MIN_CHUNK) {
        // Narrow the window and retry the same start; the floor is where even the smallest read fails.
        width = width / 2n < MIN_CHUNK ? MIN_CHUNK : width / 2n;
        continue;
      }
      metrics.count("index.sweep", false, err instanceof Error ? err.message.slice(0, 160) : String(err));
      // A run that read nothing is a failure worth reporting, not a partial sweep: with the cursor
      // unmoved, "ok" would hide a stall until someone reads the lag by hand.
      if (covered < from) throw err;
      break;
    }
    const rows = toRows(logs as RawLog[]);
    found += rows.length;
    kept.push(...rows.filter((r) => wallets.has(r.from.toLowerCase()) || wallets.has(r.to.toLowerCase())));
    covered = end;
    start = end + 1n;
  }
  const added = kept.length > 0 ? await repos.chainTransfers.insertMany(await withTimes(kept)) : 0;
  if (covered >= from) await repos.cursors.set(CURSOR_KEY, Number(covered)).catch(() => undefined);
  metrics.count("index.sweep", true, `${found} transfers seen, ${added} kept`);
  return { ...base, toBlock: covered.toString(), found, added, more: covered < head };
}

/** Base mines a block every two seconds, so a block count converts straight into how stale the index is. */
const BLOCK_SECONDS = 2;

export interface IndexStatus {
  cursor: number | null;
  head: number;
  /** Blocks the sweep has not read yet — the age of the oldest transfer a timeline could be missing. */
  lag: number;
  lagSeconds: number;
  wallets: number;
}

/**
 * How far behind the transfer index is.
 *
 * The number that says whether the sweep is keeping up, and the one worth looking at first when a
 * timeline is missing a trade: the tail read covers a few thousand blocks, so a lag past that is
 * the point where the cursor needs walking forward rather than waiting.
 */
export async function indexStatus(): Promise<IndexStatus> {
  const repos = getRepos();
  const [head, cursor, wallets] = await Promise.all([
    getServerPublicClient().getBlockNumber(),
    repos.cursors.get(CURSOR_KEY).catch(() => null),
    repos.walletIndex.listWallets().catch(() => [] as Address[]),
  ]);
  const lag = cursor === null ? 0 : Math.max(0, Number(head) - cursor);
  return { cursor, head: Number(head), lag, lagSeconds: lag * BLOCK_SECONDS, wallets: wallets.length };
}

/**
 * The blocks the sweep has not reached yet, read once for everyone and cached briefly: a
 * transfer mined a minute ago shows up without waiting for the next sweep.
 */
async function tailTransfers(): Promise<IndexedTransfer[]> {
  return cached("index:tail", { ttlMs: 45_000, staleMs: 3 * 60_000, shared: true }, async () => {
    const repos = getRepos();
    const client = getLogPublicClient();
    const head = await client.getBlockNumber();
    const cursor = await repos.cursors.get(CURSOR_KEY).catch(() => null);
    let from = cursor !== null ? BigInt(cursor) + 1n : head - 500n;
    if (head - from > TAIL_MAX_BLOCKS) from = head - TAIL_MAX_BLOCKS;
    if (from > head) return [];
    const tokens = await stockAddresses();
    const rows: IndexedTransfer[] = [];
    for (let start = from; start <= head; start += CHUNK + 1n) {
      const end = start + CHUNK > head ? head : start + CHUNK;
      const logs = await getLogsAdaptive(start, end, (a, b) => client.getLogs({ address: tokens, event: TRANSFER_EVENT, fromBlock: a, toBlock: b }));
      rows.push(...toRows(logs as RawLog[]));
    }
    return withTimes(rows);
  });
}

/** A wallet's transfers for the timeline: the index plus the unswept tail. */
export async function transfersForWallet(owner: Address): Promise<TimelineTransfer[]> {
  const repos = getRepos();
  const row = await registerWallet(owner).catch((err) => {
    metrics.count("index.register", false, err instanceof Error ? err.message : String(err));
    return null;
  });
  if (row) await continueBackfill(row).catch((err) => metrics.count("index.backfill", false, err instanceof Error ? err.message : String(err)));
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
