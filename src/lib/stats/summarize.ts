import type { DayRollup, StatsCounter, StatsSummary } from "@/domain/stats";
import type { StatEvent } from "./extract";

/**
 * The reductions over extracted events: the window counters, and the per-route, per-stock and
 * per-venue breakdowns. Each has a twin that adds a stored day's rollup onto the same shape, so a
 * day computed live and a day read from its rollup add to the same totals.
 */
export const emptySummary = (): StatsSummary => ({ trades: 0, tradeVolumeUsd: 0, buys: 0, buyVolumeUsd: 0, sells: 0, sellVolumeUsd: 0, wallets: 0, directGifts: 0, linksCreated: 0, linksClaimed: 0, poolsCreated: 0, poolClaims: 0, earnDeposits: 0, earnDepositUsd: 0, earnWithdrawals: 0, earnWithdrawalUsd: 0, lpAdds: 0, lpAddUsd: 0, basketsBuilt: 0, planRuns: 0, planRunUsd: 0, reverted: 0 });

/** Counters over the events at or after `since`; `wallets` is the set behind `summary.wallets`. */
export function summarize(events: StatEvent[], since: number, basketsBuiltAt: number[], runsAt: Array<{ at: number; usd: number }>): { summary: StatsSummary; wallets: Set<string> } {
  const s = emptySummary();
  const wallets = new Set<string>();
  for (const e of events) {
    if (e.at < since) continue;
    if (e.state === "reverted") {
      s.reverted += 1;
      continue;
    }
    if (e.state !== "verified") continue;
    wallets.add(e.wallet);
    const usd = e.usd ?? 0;
    switch (e.kind) {
      case "buy":
        s.trades += 1;
        s.buys += 1;
        s.tradeVolumeUsd += usd;
        s.buyVolumeUsd += usd;
        break;
      case "sell":
        s.trades += 1;
        s.sells += 1;
        s.tradeVolumeUsd += usd;
        s.sellVolumeUsd += usd;
        break;
      case "gift":
        s.directGifts += 1;
        break;
      case "link":
        s.linksCreated += 1;
        break;
      case "link-claim":
        s.linksClaimed += 1;
        break;
      case "pool":
        s.poolsCreated += 1;
        break;
      case "pool-claim":
        s.poolClaims += 1;
        break;
      case "earn-deposit":
        s.earnDeposits += 1;
        s.earnDepositUsd += usd;
        break;
      case "earn-withdraw":
        s.earnWithdrawals += 1;
        s.earnWithdrawalUsd += usd;
        break;
      case "lp-add":
        s.lpAdds += 1;
        s.lpAddUsd += usd;
        break;
      default:
        break;
    }
  }
  s.basketsBuilt = basketsBuiltAt.filter((at) => at >= since).length;
  for (const r of runsAt) {
    if (r.at < since) continue;
    s.planRuns += 1;
    s.planRunUsd += r.usd;
  }
  s.wallets = wallets.size;
  return { summary: s, wallets };
}

/** Adds a rollup's counters onto a summary (the event-derived fields only; baskets and plan runs stay record-derived). */
export function addRollupSummary(s: StatsSummary, r: DayRollup): void {
  const src = r.summary;
  s.trades += src.trades;
  s.tradeVolumeUsd += src.tradeVolumeUsd;
  s.buys += src.buys;
  s.buyVolumeUsd += src.buyVolumeUsd;
  s.sells += src.sells;
  s.sellVolumeUsd += src.sellVolumeUsd;
  s.directGifts += src.directGifts;
  s.linksCreated += src.linksCreated;
  s.linksClaimed += src.linksClaimed;
  s.poolsCreated += src.poolsCreated;
  s.poolClaims += src.poolClaims;
  s.earnDeposits += src.earnDeposits;
  s.earnDepositUsd += src.earnDepositUsd;
  s.earnWithdrawals += src.earnWithdrawals;
  s.earnWithdrawalUsd += src.earnWithdrawalUsd;
  s.lpAdds += src.lpAdds;
  s.lpAddUsd += src.lpAddUsd;
  s.reverted += src.reverted;
}

export interface Breakdown {
  byProvider: Map<string, StatsCounter>;
  byAsset: Map<string, { buys: number; buyUsd: number; sells: number; sellUsd: number; gifted: number }>;
  earnByProvider: Map<string, { deposits: number; depositUsd: number; withdrawals: number; withdrawalUsd: number }>;
  liquidity: { added: StatsCounter; removed: StatsCounter; collected: StatsCounter };
  feeUsd: number;
}

export const emptyBreakdown = (): Breakdown => ({ byProvider: new Map(), byAsset: new Map(), earnByProvider: new Map(), liquidity: { added: { count: 0, usd: 0 }, removed: { count: 0, usd: 0 }, collected: { count: 0, usd: 0 } }, feeUsd: 0 });

/** Per-route, per-stock and per-venue totals over verified events, added onto `into`. */
export function breakdown(verified: StatEvent[], assetByTx: Map<string, string>, into: Breakdown = emptyBreakdown()): Breakdown {
  const assetRow = (assetId: string) => {
    const row = into.byAsset.get(assetId) ?? { buys: 0, buyUsd: 0, sells: 0, sellUsd: 0, gifted: 0 };
    into.byAsset.set(assetId, row);
    return row;
  };
  for (const e of verified) {
    if (e.kind === "buy" || e.kind === "sell") {
      const p = into.byProvider.get(e.provider ?? "unknown") ?? { count: 0, usd: 0 };
      p.count += 1;
      p.usd += e.usd ?? 0;
      into.byProvider.set(e.provider ?? "unknown", p);
      into.feeUsd += e.feeUsd ?? 0;
      const assetId = e.units?.[0]?.assetId ?? assetByTx.get(e.txHash);
      if (assetId) {
        const row = assetRow(assetId);
        if (e.kind === "buy") {
          row.buys += 1;
          row.buyUsd += e.usd ?? 0;
        } else {
          row.sells += 1;
          row.sellUsd += e.usd ?? 0;
        }
      }
      continue;
    }
    if (e.kind === "gift" || e.kind === "link-claim" || e.kind === "pool-claim") {
      for (const u of e.units ?? []) assetRow(u.assetId).gifted += u.units;
      continue;
    }
    const bucket = e.kind === "lp-add" ? into.liquidity.added : e.kind === "lp-remove" ? into.liquidity.removed : e.kind === "lp-collect" ? into.liquidity.collected : null;
    if (bucket) {
      bucket.count += 1;
      bucket.usd += e.usd ?? 0;
      continue;
    }
    if (e.kind !== "earn-deposit" && e.kind !== "earn-withdraw") continue;
    const row = into.earnByProvider.get(e.provider ?? "unknown") ?? { deposits: 0, depositUsd: 0, withdrawals: 0, withdrawalUsd: 0 };
    if (e.kind === "earn-deposit") {
      row.deposits += 1;
      row.depositUsd += e.usd ?? 0;
    } else {
      row.withdrawals += 1;
      row.withdrawalUsd += e.usd ?? 0;
    }
    into.earnByProvider.set(e.provider ?? "unknown", row);
  }
  return into;
}

export function addRollupBreakdown(into: Breakdown, r: DayRollup): void {
  for (const [k, v] of Object.entries(r.byProvider)) {
    const p = into.byProvider.get(k) ?? { count: 0, usd: 0 };
    p.count += v.count;
    p.usd += v.usd;
    into.byProvider.set(k, p);
  }
  for (const [k, v] of Object.entries(r.byAsset)) {
    const row = into.byAsset.get(k) ?? { buys: 0, buyUsd: 0, sells: 0, sellUsd: 0, gifted: 0 };
    row.buys += v.buys;
    row.buyUsd += v.buyUsd;
    row.sells += v.sells;
    row.sellUsd += v.sellUsd;
    row.gifted += v.gifted;
    into.byAsset.set(k, row);
  }
  for (const [k, v] of Object.entries(r.earnByProvider)) {
    const row = into.earnByProvider.get(k) ?? { deposits: 0, depositUsd: 0, withdrawals: 0, withdrawalUsd: 0 };
    row.deposits += v.deposits;
    row.depositUsd += v.depositUsd;
    row.withdrawals += v.withdrawals;
    row.withdrawalUsd += v.withdrawalUsd;
    into.earnByProvider.set(k, row);
  }
  for (const key of ["added", "removed", "collected"] as const) {
    into.liquidity[key].count += r.liquidity[key].count;
    into.liquidity[key].usd += r.liquidity[key].usd;
  }
  into.feeUsd += r.feeUsd;
}
