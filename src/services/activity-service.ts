import { formatUnits, type Address, type Hash } from "viem";
import type { ActivityItem } from "@/domain/activity";
import type { PoolRecord } from "@/domain/pool";
import { b20AssetAbi } from "@/lib/b20/abi";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { cached } from "@/lib/cache";
import { metrics } from "@/lib/http";
import { getRepos } from "@/db/repositories";
import { getAssets } from "./b20-asset-service";
import { reverseResolve } from "./basename-service";
import { blockTimes, getReceiptStates } from "./receipt-service";
import { reconcileEarnForWallet } from "./earn-reconcile-service";
import { buildTimeline, settleRecord, type TimelineTransfer } from "@/lib/activity/timeline";
import { USDC_DECIMALS } from "@/config/chain";

export { settleRecord };
export type { ReceiptState } from "./receipt-service";

/**
 * Unified activity timeline (spec §33).
 * Sources: app records (trades, gifts, baskets, earn, pools) and the chain's own `Transfer` logs.
 * The rows are assembled by `buildTimeline`, which is pure; this file does the reading.
 * An app record is "verified" when the chain shows the transfer or the receipt says it succeeded.
 */
const LOOKBACK_BLOCKS = 120_000n;
const CHUNK = 10_000n;
/** How many app-record hashes one timeline read verifies at most; the rest stay pending until the next look. */
const MAX_RECEIPTS = 120;

interface ScanState {
  upTo: bigint;
  items: TimelineTransfer[];
  at: number;
}
/** Per-owner scan position so a refresh only reads the blocks mined since the last scan (bounded owners). */
const SCAN_STATE = new Map<string, ScanState>();
const SCAN_STATE_MAX = 300;

async function scanTransfers(owner: Address, assets: Address[]): Promise<TimelineTransfer[]> {
  const key = owner.toLowerCase();
  return cached(`activity:scan:${key}`, { ttlMs: 90_000, staleMs: 10 * 60_000 }, async () => {
    const client = getServerPublicClient();
    const latest = await client.getBlockNumber();
    const floor = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;
    const prev = SCAN_STATE.get(key);
    const incremental = !!prev && prev.upTo >= floor;
    const from = incremental ? prev.upTo + 1n : floor;
    const out: TimelineTransfer[] = incremental ? prev.items.filter((t) => t.blockNumber >= floor) : [];
    let upTo = incremental ? prev.upTo : floor - 1n;
    const transferEvent = b20AssetAbi.find((x) => x.type === "event" && x.name === "Transfer")!;
    for (let start = from; start <= latest; start += CHUNK + 1n) {
      const end = start + CHUNK > latest ? latest : start + CHUNK;
      try {
        const [sent, received] = await Promise.all([
          client.getLogs({ address: assets, event: transferEvent as typeof b20AssetAbi[number] & { type: "event" }, args: { from: owner }, fromBlock: start, toBlock: end }),
          client.getLogs({ address: assets, event: transferEvent as typeof b20AssetAbi[number] & { type: "event" }, args: { to: owner }, fromBlock: start, toBlock: end }),
        ]);
        for (const log of [...sent, ...received]) {
          const args = log.args as { from?: Address; to?: Address; value?: bigint };
          if (!args.from || !args.to || args.value === undefined || !log.transactionHash || log.blockNumber === null) continue;
          out.push({ txHash: log.transactionHash, blockNumber: log.blockNumber, asset: log.address as Address, from: args.from, to: args.to, value: args.value });
        }
        upTo = end;
      } catch (err) {
        metrics.count("activity.scan", false, err instanceof Error ? err.message : String(err));
        break; // public RPC range limit: keep what we have and resume from `upTo` next time
      }
    }
    // de-dupe (a self-transfer appears twice; incremental merges could repeat a boundary block)
    const seen = new Set<string>();
    const deduped = out.filter((t) => {
      const k = `${t.txHash}:${t.asset}:${t.from}:${t.to}:${t.value}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // Block times, so a transfer nobody recorded still sorts by when it happened.
    const times = await blockTimes(deduped.filter((t) => t.timestamp === undefined).map((t) => Number(t.blockNumber))).catch(() => new Map<number, number>());
    for (const t of deduped) if (t.timestamp === undefined) t.timestamp = times.get(Number(t.blockNumber));
    if (SCAN_STATE.size >= SCAN_STATE_MAX) {
      const oldest = [...SCAN_STATE.entries()].sort((x, y) => x[1].at - y[1].at)[0];
      if (oldest) SCAN_STATE.delete(oldest[0]);
    }
    SCAN_STATE.set(key, { upTo, items: deduped, at: Date.now() });
    return deduped;
  });
}

export async function getActivity(owner: Address): Promise<ActivityItem[]> {
  const repos = getRepos();
  const assets = await getAssets();
  // A deposit whose record the browser lost is filled in from the venue's event before the read.
  await reconcileEarnForWallet(owner).catch(() => undefined);
  const [trades, gifts, executions, earnActions, pools, claims, transfers] = await Promise.all([
    repos.trades.listByOwner(owner),
    repos.gifts.listByOwner(owner),
    repos.executions.listByOwner(owner),
    repos.earnActions.listByOwner(owner),
    repos.pools.listByCreator(owner).catch(() => [] as PoolRecord[]),
    repos.poolClaims.listByClaimant(owner).catch(() => []),
    scanTransfers(owner, assets.map((a) => a.address)).catch(() => [] as TimelineTransfer[]),
  ]);
  // The pools behind this wallet's claims (its own pools are already in hand).
  const poolById = new Map(pools.map((p) => [p.id, p]));
  const missingPoolIds = [...new Set(claims.map((c) => c.poolId).filter((id) => !poolById.has(id)))];
  await Promise.all(
    missingPoolIds.map(async (id) => {
      const p = await repos.pools.get(id).catch(() => null);
      if (p) poolById.set(id, p);
    }),
  );

  // Every hash an app record points at, settled by its receipt (cached durably; the chain is asked once).
  const hashes = new Set<string>();
  for (const t of trades) if (t.txHash) hashes.add(t.txHash);
  for (const g of gifts) {
    if (g.txHash) hashes.add(g.txHash);
    if (g.claimTx) hashes.add(g.claimTx);
  }
  for (const e of executions) for (const s of e.steps) if (s.txHash) hashes.add(s.txHash);
  for (const a of earnActions) if (a.txHash) hashes.add(a.txHash);
  for (const p of pools) if (p.txHash) hashes.add(p.txHash);
  for (const c of claims) if (c.txHash) hashes.add(c.txHash);
  const receipts = await getReceiptStates([...hashes].slice(0, MAX_RECEIPTS) as Hash[]).catch(() => new Map());

  const items = buildTimeline({
    owner,
    assets: assets.map((a) => ({ canonicalId: a.canonicalId, address: a.address, symbol: a.symbol, decimals: a.decimals })),
    trades,
    gifts,
    executions,
    earnActions,
    pools,
    poolClaims: claims.map((claim) => ({ claim, pool: poolById.get(claim.poolId) ?? null })),
    transfers,
    receipts,
  });

  // Resolve Basenames for counterparties (best effort, cached).
  const counterparties = Array.from(new Set(items.map((i) => i.counterparty).filter((x): x is Address => !!x))).slice(0, 25);
  const names = await Promise.all(counterparties.map((a) => reverseResolve(a).catch(() => null)));
  const nameMap = new Map(counterparties.map((a, i) => [a.toLowerCase(), names[i]]));
  for (const i of items) if (i.counterparty && !i.counterpartyBasename) i.counterpartyBasename = nameMap.get(i.counterparty.toLowerCase()) ?? undefined;
  // BStocks handles for counterparties with a public profile here ("this member sent you a gift").
  const profiles = await Promise.all(counterparties.map((a) => repos.profiles.get(a).catch(() => null)));
  const handleMap = new Map(counterparties.map((a, i) => [a.toLowerCase(), profiles[i]?.isPublic ? profiles[i]?.handle : undefined]));
  for (const i of items) if (i.counterparty && !i.counterpartyHandle) i.counterpartyHandle = handleMap.get(i.counterparty.toLowerCase()) ?? undefined;

  return items;
}

export function usdcAmount(raw: string): number {
  return Number(formatUnits(BigInt(raw), USDC_DECIMALS));
}
