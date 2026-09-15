import { formatUnits, type Address, type Hash } from "viem";
import type { ActivityItem } from "@/domain/activity";
import type { PoolRecord } from "@/domain/pool";
import { getRepos } from "@/db/repositories";
import { getAssets } from "./b20-asset-service";
import { reverseResolve } from "./basename-service";
import { getReceiptStates, type ReceiptState } from "./receipt-service";
import { transfersForWallet } from "./chain-index-service";
import { buildTimeline, settleRecord, type TimelineTransfer } from "@/lib/activity/timeline";
import { USDC_DECIMALS } from "@/config/chain";

export { settleRecord };
export type { ReceiptState } from "./receipt-service";

/**
 * Unified activity timeline (spec §33).
 * Sources: app records (trades, gifts, baskets, earn, pools) and the wallet's own transfers from
 * the app's index of tokenized-stock transfers (`chain-index-service`), which replaced the
 * per-wallet log scan. The rows are assembled by `buildTimeline`, which is pure; this file does
 * the reading. An app record is "verified" when the chain shows the transfer or the server has
 * matched it to its receipt.
 */
/**
 * How many hashes one timeline read may ask the *chain* about; the rest stay pending until the next
 * look. Receipts already stored in `tx_receipts` cost a table read and are never capped: with the
 * cap on the whole list, a wallet past 120 hashes had its oldest Earn rows marked "Pending" for good.
 */
const MAX_CHAIN_RECEIPTS = 120;

/**
 * `allowBackfill: false` reads the timeline without making the wallet part of the transfer index.
 * Registering a wallet scans its recent chain history and reconciles its Earn venues, which is
 * real work; the activity route lets an unauthenticated request trigger it only for a wallet that
 * has some footprint here. A wallet already in the index is read as usual either way.
 */
export async function getActivity(owner: Address, opts: { allowBackfill?: boolean } = {}): Promise<ActivityItem[]> {
  const repos = getRepos();
  const assets = await getAssets();
  const indexed = opts.allowBackfill === false ? !!(await repos.walletIndex.get(owner).catch(() => null)) : true;
  const [trades, gifts, executions, earnActions, pools, claims, transfers] = await Promise.all([
    repos.trades.listByOwner(owner),
    repos.gifts.listByOwner(owner),
    repos.executions.listByOwner(owner),
    repos.earnActions.listByOwner(owner),
    repos.pools.listByCreator(owner).catch(() => [] as PoolRecord[]),
    repos.poolClaims.listByClaimant(owner).catch(() => []),
    indexed ? transfersForWallet(owner).catch(() => [] as TimelineTransfer[]) : Promise.resolve([] as TimelineTransfer[]),
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
  const receipts = await receiptStates([...hashes] as Hash[]);

  const items = buildTimeline({
    owner,
    assets: assets.map((a) => ({ canonicalId: a.canonicalId, address: a.address, symbol: a.symbol, decimals: a.decimals, multiplier: a.multiplier.toString(), wadPrecision: a.wadPrecision.toString() })),
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

/** Stored receipts for every hash, then the chain for at most `MAX_CHAIN_RECEIPTS` of the rest. */
async function receiptStates(hashes: Hash[]): Promise<Map<string, ReceiptState>> {
  const out = new Map<string, ReceiptState>();
  if (hashes.length === 0) return out;
  const stored = await getRepos().receipts.getMany(hashes).catch(() => []);
  for (const r of stored) out.set(r.txHash.toLowerCase(), { status: r.status, blockNumber: r.blockNumber, blockTime: r.blockTime });
  const missing = hashes.filter((h) => !out.has(h.toLowerCase())).slice(0, MAX_CHAIN_RECEIPTS);
  // `getReceiptStates` re-checks memory and the table first, so a stored hash is never re-fetched;
  // the slice bounds only the hashes the chain has to be asked about.
  const fresh = await getReceiptStates(missing).catch(() => new Map<string, ReceiptState>());
  for (const [k, v] of fresh) out.set(k, v);
  return out;
}

export function usdcAmount(raw: string): number {
  return Number(formatUnits(BigInt(raw), USDC_DECIMALS));
}
