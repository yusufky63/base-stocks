import type { Hash } from "viem";
import type { PlatformStats } from "@/domain/stats";
import { getRepos } from "@/db/repositories";
import { cached } from "@/lib/cache";
import { monthlySpendUsd } from "@/lib/ai-quota";
import { aggregateStats } from "@/lib/stats/aggregate";
import { getAssets } from "./b20-asset-service";
import { getPriceViews } from "./price-service";
import { getReceiptStates } from "./receipt-service";
import { sweepEarn } from "./earn-reconcile-service";
import { verifyPendingRecords } from "./verify-records-service";
import { metrics } from "@/lib/http";

/**
 * Platform-wide statistics: every record the app holds, verified against Base, aggregated by
 * `aggregateStats`. Reading everything is deliberate — the numbers must be reproducible from the
 * tables, not maintained as counters that drift — and cheap enough at this scale; the receipt
 * cache means the chain is asked once per transaction, ever.
 */
const CACHE = { ttlMs: 5 * 60_000, staleMs: 60 * 60_000, shared: true };
/** Receipts verified per computation at most; anything beyond is reported as unchecked, not guessed. */
const MAX_RECEIPTS = 3_000;

export async function getPlatformStats(): Promise<PlatformStats> {
  return cached("stats:platform", CACHE, compute);
}

async function compute(): Promise<PlatformStats> {
  const repos = getRepos();
  // Before anything is counted: records filed while their receipt was pending are matched to the
  // chain, and deposits the browser never recorded are filled in from the venues' own events.
  // Both are incremental (cursors, unverified rows only), so this is a handful of reads.
  await verifyPendingRecords().catch((err) => metrics.count("verify.sweep", false, err instanceof Error ? err.message : String(err)));
  await sweepEarn().catch((err) => metrics.count("earn.sweep", false, err instanceof Error ? err.message : String(err)));
  const [assets, trades, gifts, executions, earnActions, pools, poolClaims, rules, profiles, baskets, watchlists, portfolioWallets, digests, aiSpendUsd] = await Promise.all([
    getAssets(),
    repos.trades.listAll(),
    repos.gifts.listAll(),
    repos.executions.listAll(),
    repos.earnActions.listAll(),
    repos.pools.listAll(),
    repos.poolClaims.listAll(),
    repos.automation.listAll(),
    repos.profiles.listAll(),
    repos.baskets.list({ sort: "new", limit: 1_000 }),
    repos.watchlists.summary(),
    repos.snapshots.countWallets(),
    repos.digests.summary(),
    monthlySpendUsd().catch(() => 0),
  ]);
  const prices = await getPriceViews(assets).catch(() => new Map());

  const hashes = new Set<string>();
  for (const t of trades) if (t.txHash) hashes.add(t.txHash);
  for (const g of gifts) {
    if (g.txHash) hashes.add(g.txHash);
    if (g.claimTx) hashes.add(g.claimTx);
  }
  for (const e of executions) for (const s of e.steps) if (s.txHash) hashes.add(s.txHash);
  for (const a of earnActions) if (a.txHash) hashes.add(a.txHash);
  for (const p of pools) if (p.txHash) hashes.add(p.txHash);
  for (const c of poolClaims) if (c.txHash) hashes.add(c.txHash);
  for (const r of rules) for (const h of r.config.history ?? []) if (h.txHash) hashes.add(h.txHash);
  const all = [...hashes] as Hash[];
  const receipts = await getReceiptStates(all.slice(0, MAX_RECEIPTS));

  return aggregateStats({
    now: Date.now(),
    assets: assets.map((a) => ({ canonicalId: a.canonicalId, address: a.address, symbol: a.symbol, underlying: a.underlying, decimals: a.decimals, priceUsd: prices.get(a.canonicalId)?.displayUsd ?? null })),
    trades,
    gifts,
    executions,
    earnActions,
    pools,
    poolClaims,
    rules,
    profiles,
    baskets,
    watchlists,
    portfolioWallets,
    digests,
    aiSpendUsd,
    receipts,
    unchecked: Math.max(0, all.length - MAX_RECEIPTS),
  });
}
