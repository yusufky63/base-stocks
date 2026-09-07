import type { Address, Hash } from "viem";
import { getRepos, type EarnActionRecord, type ReceiptRow } from "@/db/repositories";
import { metrics } from "@/lib/http";
import { getServerPublicClient, getLogPublicClient } from "@/lib/viem/server-client";
import { USDC_ADDRESS } from "@/config/chain";
import { AAVE_SUPPLY, AAVE_WITHDRAW, COMET_SUPPLY, COMET_WITHDRAW, ERC4626_DEPOSIT, ERC4626_WITHDRAW, decodeVenueEvent, earnRecordFromEvent, earnRecordId, type EarnVenue, type VenueEvent } from "@/lib/earn/venue-events";
import { discoverUsdcEarn } from "./earn-opportunity-service";
import { blockTimes } from "./receipt-service";

/**
 * Pulls the Earn records back into line with the venues' own events, the way `reconcilePool`
 * does for gift pools. The browser writes a record after a deposit; the chain is what proves it
 * and what fills the gaps. Two entry points:
 *
 * - `sweepEarn` walks forward from a stored cursor over every wallet the app knows, for the
 *   statistics and the daily cron. Bounded per call so a serverless invocation stays inside its budget.
 * - `registerWallet` (chain-index-service) reconciles one wallet once, when it first appears.
 *
 * Both are idempotent: a transaction already recorded (by the browser or an earlier sweep) is skipped.
 */

/** Just before the first BaseStocks transaction on Base (2 Sep 2026); nothing of ours is older. */
export const EARN_SCAN_FLOOR_BLOCK = 50_700_000n;
const CHUNK = 10_000n;
const DEFAULT_MAX_BLOCKS = 120_000n;
const WALLET_BATCH = 200;
const CURSOR_KEY = "earn:sweep";

/** The USDC venues the app can deposit into, as the reconciliation sees them. */
export async function earnVenues(): Promise<EarnVenue[]> {
  const { opportunities } = await discoverUsdcEarn();
  const out: EarnVenue[] = [];
  for (const o of opportunities) {
    if (o.provider === "aave" && typeof o.metadata.pool === "string") out.push({ kind: "aave", address: o.metadata.pool as Address, provider: "aave", opportunityId: o.id });
    else if (o.provider === "morpho" && typeof o.metadata.vault === "string") out.push({ kind: "erc4626", address: o.metadata.vault as Address, provider: "morpho", opportunityId: o.id });
    else if (o.provider === "compound" && typeof o.metadata.comet === "string") out.push({ kind: "comet", address: o.metadata.comet as Address, provider: "compound", opportunityId: o.id });
  }
  return out;
}

/** Every wallet the app has any record of; a deposit whose record was lost still belongs to one of these. */
export async function knownWallets(): Promise<Address[]> {
  const repos = getRepos();
  const [trades, gifts, executions, earn, pools, claims, rules, profiles, baskets, snapshotWallets, indexedWallets] = await Promise.all([
    repos.trades.listAll(),
    repos.gifts.listAll(),
    repos.executions.listAll(),
    repos.earnActions.listAll(),
    repos.pools.listAll(),
    repos.poolClaims.listAll(),
    repos.automation.listAll(),
    repos.profiles.listAll(),
    repos.baskets.list({ sort: "new", limit: 1_000 }),
    repos.snapshots.listWallets(),
    repos.walletIndex.listWallets(),
  ]);
  const set = new Set<string>();
  const add = (a: string | undefined) => {
    if (a && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a)) set.add(a.toLowerCase());
  };
  for (const t of trades) add(t.owner);
  for (const g of gifts) {
    add(g.sender);
    add(g.recipient);
  }
  for (const e of executions) add(e.owner);
  for (const a of earn) add(a.owner);
  for (const p of pools) add(p.creator);
  for (const c of claims) add(c.claimant);
  for (const r of rules) add(r.owner);
  for (const p of profiles) add(p.address);
  for (const b of baskets) add(b.owner);
  for (const w of snapshotWallets) add(w);
  for (const w of indexedWallets) add(w);
  return [...set] as Address[];
}

interface Scan {
  venue: EarnVenue;
  action: "deposit" | "withdraw";
}

async function readEvents(venues: EarnVenue[], wallets: Address[], fromBlock: bigint, toBlock: bigint): Promise<Array<{ venue: EarnVenue; ev: VenueEvent }>> {
  const client = getLogPublicClient();
  const out: Array<{ venue: EarnVenue; ev: VenueEvent }> = [];
  const aave = venues.filter((v) => v.kind === "aave");
  const vaults = venues.filter((v) => v.kind === "erc4626");
  const comets = venues.filter((v) => v.kind === "comet");
  const byAddress = new Map(venues.map((v) => [v.address.toLowerCase(), v]));
  const push = (kind: EarnVenue["kind"], action: Scan["action"], logs: Array<{ address: Address; args: unknown; transactionHash: Hash | null; blockNumber: bigint | null; logIndex: number | null }>) => {
    for (const log of logs) {
      const venue = byAddress.get(log.address.toLowerCase());
      if (!venue || !log.transactionHash || log.blockNumber === null || log.logIndex === null) continue;
      const ev = decodeVenueEvent(kind, action, log.args as Record<string, unknown>, { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex });
      if (ev) out.push({ venue, ev });
    }
  };
  for (let i = 0; i < wallets.length; i += WALLET_BATCH) {
    const batch = wallets.slice(i, i + WALLET_BATCH);
    const calls: Array<Promise<void>> = [];
    if (aave.length > 0) {
      const address = aave.map((v) => v.address);
      calls.push(client.getLogs({ address, event: AAVE_SUPPLY, args: { reserve: USDC_ADDRESS, onBehalfOf: batch }, fromBlock, toBlock }).then((logs) => push("aave", "deposit", logs)));
      calls.push(client.getLogs({ address, event: AAVE_WITHDRAW, args: { reserve: USDC_ADDRESS, user: batch }, fromBlock, toBlock }).then((logs) => push("aave", "withdraw", logs)));
    }
    if (vaults.length > 0) {
      const address = vaults.map((v) => v.address);
      calls.push(client.getLogs({ address, event: ERC4626_DEPOSIT, args: { owner: batch }, fromBlock, toBlock }).then((logs) => push("erc4626", "deposit", logs)));
      calls.push(client.getLogs({ address, event: ERC4626_WITHDRAW, args: { owner: batch }, fromBlock, toBlock }).then((logs) => push("erc4626", "withdraw", logs)));
    }
    if (comets.length > 0) {
      const address = comets.map((v) => v.address);
      calls.push(client.getLogs({ address, event: COMET_SUPPLY, args: { dst: batch }, fromBlock, toBlock }).then((logs) => push("comet", "deposit", logs)));
      calls.push(client.getLogs({ address, event: COMET_WITHDRAW, args: { src: batch }, fromBlock, toBlock }).then((logs) => push("comet", "withdraw", logs)));
    }
    await Promise.all(calls);
  }
  return out;
}

export interface ReconcileResult {
  fromBlock: string;
  toBlock: string;
  found: number;
  added: number;
}

/**
 * Reads every venue event for `wallets` between two blocks and writes the records that are
 * missing. The receipt of each new record is stored as verified at the same time — the log is
 * the receipt — so the statistics never have to ask the chain about it again.
 */
export async function reconcileEarn(wallets: Address[], fromBlock: bigint, toBlock: bigint): Promise<ReconcileResult> {
  const result: ReconcileResult = { fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), found: 0, added: 0 };
  if (wallets.length === 0 || fromBlock > toBlock) return result;
  const repos = getRepos();
  const venues = await earnVenues();
  if (venues.length === 0) return result;

  const events: Array<{ venue: EarnVenue; ev: VenueEvent }> = [];
  for (let start = fromBlock; start <= toBlock; start += CHUNK + 1n) {
    const end = start + CHUNK > toBlock ? toBlock : start + CHUNK;
    try {
      events.push(...(await readEvents(venues, wallets, start, end)));
    } catch (err) {
      metrics.count("earn.reconcile", false, err instanceof Error ? err.message : String(err));
      throw err; // keep the cursor where it was; the next run retries this range
    }
  }
  result.found = events.length;
  if (events.length === 0) return result;

  // What is already on file, by transaction and action: the browser's record or an earlier sweep.
  const existing = await repos.earnActions.listAll();
  const have = new Set(existing.filter((a) => a.txHash).map((a) => `${a.txHash!.toLowerCase()}:${a.action}`));
  const ids = new Set(existing.map((a) => a.id));
  const times = await blockTimes(events.map((e) => Number(e.ev.blockNumber))).catch(() => new Map<number, number>());

  const receipts: ReceiptRow[] = [];
  for (const { venue, ev } of events.sort((a, b) => Number(a.ev.blockNumber - b.ev.blockNumber) || a.ev.logIndex - b.ev.logIndex)) {
    const key = `${ev.txHash.toLowerCase()}:${ev.action}`;
    if (have.has(key)) continue;
    let id = earnRecordId(ev.txHash);
    if (ids.has(id)) id = earnRecordId(ev.txHash, ev.logIndex);
    if (ids.has(id)) continue;
    const blockTime = times.get(Number(ev.blockNumber));
    const record: EarnActionRecord = earnRecordFromEvent(venue, ev, blockTime, id);
    try {
      await repos.earnActions.create(record);
      have.add(key);
      ids.add(id);
      result.added += 1;
      receipts.push({ txHash: ev.txHash, status: "success", blockNumber: Number(ev.blockNumber), blockTime });
    } catch (err) {
      metrics.count("earn.reconcile.write", false, err instanceof Error ? err.message : String(err));
    }
  }
  if (receipts.length > 0) await repos.receipts.putMany(receipts).catch(() => undefined);
  metrics.count("earn.reconcile", true, `${result.found} events, ${result.added} added`);
  return result;
}

export interface SweepResult extends ReconcileResult {
  head: string;
  wallets: number;
  /** True when the sweep stopped short of the head and the next one continues from `toBlock`. */
  more: boolean;
}

/**
 * The cursor-driven sweep over every known wallet. Reads at most `maxBlocks` per call and
 * remembers where it stopped, so the daily cron and the statistics keep the records complete
 * without ever re-reading old blocks.
 */
export async function sweepEarn(opts: { fromBlock?: bigint; maxBlocks?: bigint } = {}): Promise<SweepResult> {
  const repos = getRepos();
  const client = getServerPublicClient();
  const head = await client.getBlockNumber();
  const cursor = opts.fromBlock !== undefined ? null : await repos.cursors.get(CURSOR_KEY).catch(() => null);
  const from = opts.fromBlock ?? (cursor !== null ? BigInt(cursor) + 1n : EARN_SCAN_FLOOR_BLOCK);
  const max = opts.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const to = from + max - 1n < head ? from + max - 1n : head;
  const wallets = await knownWallets();
  if (from > head) return { fromBlock: from.toString(), toBlock: head.toString(), head: head.toString(), found: 0, added: 0, wallets: wallets.length, more: false };
  const r = await reconcileEarn(wallets, from, to);
  await repos.cursors.set(CURSOR_KEY, Number(to)).catch(() => undefined);
  return { ...r, head: head.toString(), wallets: wallets.length, more: to < head };
}
