import type { Address } from "viem";
import type { AssetStat, DailyStat, LedgerEntry, PlatformStats, StatsSummary, StatsWindowKey } from "@/domain/stats";
import { dayKey, extractEvents, round2, type StatsInput } from "./extract";
import { addRollupBreakdown, addRollupSummary, breakdown, summarize } from "./summarize";

/**
 * Platform statistics, computed from the app's own records and the chain's receipts. Pure: hand it
 * the records and it answers; the service around it decides what to load.
 *
 * The work is in three files. `extract.ts` turns records into events with the chain's verdict
 * attached (and states the two rules: a record counts once the chain agrees; one transaction is
 * one trade per stock). `summarize.ts` reduces events to counters and breakdowns. `rollup.ts`
 * reduces a finished day once so the live computation reads only recent records. This file
 * assembles the page from those parts and re-exports what the service and the tests need.
 *
 * Scale is handled by **daily rollups**: a finished day is reduced once to a `DayRollup` (its
 * counters, its wallets, its per-stock and per-route breakdowns) and stored; from then on the
 * live computation reads only the records of the recent days and adds the rollups for the rest.
 * The totals stay reproducible — a rollup is the same function over the same records — while the
 * cost of `/stats` stops growing with the number of records ever written.
 */
export { dayKey, type StatsAsset, type StatsInput } from "./extract";
export { buildDayRollup } from "./rollup";

const WINDOWS: Array<{ key: StatsWindowKey; ms: number | null }> = [
  { key: "24h", ms: 24 * 3600_000 },
  { key: "7d", ms: 7 * 24 * 3600_000 },
  { key: "30d", ms: 30 * 24 * 3600_000 },
  { key: "all", ms: null },
];
const DAILY_DAYS = 30;
const LEDGER_MAX = 40;

export function aggregateStats(input: StatsInput): PlatformStats {
  const { now } = input;
  const assetById = new Map(input.assets.map((a) => [a.canonicalId, a]));
  const x = extractEvents(input);

  // Live events are the ones after the rollup boundary; the rollups stand for the days before.
  const liveSince = input.liveSince ?? 0;
  const liveDay = dayKey(liveSince);
  const rollups = liveSince > 0 ? (input.rollups ?? []).filter((r) => r.day < liveDay).sort((a, b) => (a.day < b.day ? -1 : 1)) : [];
  const events = liveSince > 0 ? x.events.filter((e) => e.at >= liveSince) : x.events;
  const verified = events.filter((e) => e.state === "verified");

  /* ------------------------------- windows -------------------------------- */
  const windows = {} as Record<StatsWindowKey, StatsSummary>;
  const allWallets = new Set<string>();
  for (const { key, ms } of WINDOWS) {
    const since = ms === null ? 0 : now - ms;
    const { summary, wallets } = summarize(events, since, x.basketsBuiltAt, x.runsAt);
    if (ms === null) {
      for (const w of wallets) allWallets.add(w);
      for (const r of rollups) {
        addRollupSummary(summary, r);
        for (const w of r.wallets) allWallets.add(w);
      }
      summary.wallets = allWallets.size;
    }
    windows[key] = summary;
  }

  /* ------------------------------ breakdowns ------------------------------ */
  const b = breakdown(verified, x.assetByTx);
  for (const r of rollups) addRollupBreakdown(b, r);
  const byAsset: AssetStat[] = [...b.byAsset.entries()].map(([assetId, r]) => {
    const a = assetById.get(assetId);
    return { assetAddress: (a?.address ?? assetId) as Address, symbol: a?.symbol ?? assetId.slice(0, 8), underlying: a?.underlying ?? assetId.slice(0, 8), buys: r.buys, buyUsd: round2(r.buyUsd), sells: r.sells, sellUsd: round2(r.sellUsd), gifted: Math.round(r.gifted * 1e8) / 1e8 };
  });
  const earn = { deposits: { count: 0, usd: 0 }, withdrawals: { count: 0, usd: 0 } };
  for (const v of b.earnByProvider.values()) {
    earn.deposits.count += v.deposits;
    earn.deposits.usd += v.depositUsd;
    earn.withdrawals.count += v.withdrawals;
    earn.withdrawals.usd += v.withdrawalUsd;
  }

  /* -------------------------------- people -------------------------------- */
  const known = new Set(x.known);
  for (const w of allWallets) known.add(w);
  // The database's own distinct count covers every table and every day; the set above only sees
  // the records in hand, which after rollups is the live window.
  const knownWallets = input.knownWalletCount !== undefined ? Math.max(input.knownWalletCount, known.size) : known.size;

  /* --------------------------------- daily -------------------------------- */
  const daily: DailyStat[] = [];
  for (let i = DAILY_DAYS - 1; i >= 0; i--) daily.push({ day: dayKey(now - i * 24 * 3600_000), trades: 0, volumeUsd: 0, events: 0, wallets: 0 });
  const dayIndex = new Map(daily.map((d, i) => [d.day, i]));
  const dayWallets = new Map<string, Set<string>>();
  for (const e of verified) {
    const i = dayIndex.get(dayKey(e.at));
    if (i === undefined) continue;
    const d = daily[i]!;
    d.events += 1;
    if (e.kind === "buy" || e.kind === "sell") {
      d.trades += 1;
      d.volumeUsd += e.usd ?? 0;
    }
    const set = dayWallets.get(d.day) ?? new Set<string>();
    set.add(e.wallet);
    dayWallets.set(d.day, set);
  }
  // A rolled-up day inside the chart's range (the rollup boundary is closer than 30 days) reads from its rollup.
  for (const r of rollups) {
    const i = dayIndex.get(r.day);
    if (i === undefined) continue;
    const d = daily[i]!;
    d.events += r.events;
    d.trades += r.summary.trades;
    d.volumeUsd += r.summary.tradeVolumeUsd;
    const set = dayWallets.get(d.day) ?? new Set<string>();
    for (const w of r.wallets) set.add(w);
    dayWallets.set(d.day, set);
  }
  for (const d of daily) {
    d.wallets = dayWallets.get(d.day)?.size ?? 0;
    d.volumeUsd = round2(d.volumeUsd);
  }

  /* -------------------------------- ledger -------------------------------- */
  // One receipt, one line: records that share a hash and a kind (gift links funded together) fold
  // into one entry with a count, so the ledger reads like the chain does.
  const folded = new Map<string, LedgerEntry>();
  for (const e of [...verified].sort((a, b) => b.at - a.at || (b.blockNumber ?? 0) - (a.blockNumber ?? 0))) {
    const key = `${e.txHash}:${e.kind}`;
    const cur = folded.get(key);
    if (cur) {
      cur.count = (cur.count ?? 1) + 1;
      if (e.usd !== null) cur.usd = round2((cur.usd ?? 0) + e.usd);
      if (cur.symbol !== e.symbol) cur.symbol = `${cur.count} stocks`;
      continue;
    }
    folded.set(key, { at: e.at, kind: e.kind, label: e.label, symbol: e.symbol, usd: e.usd === null ? undefined : round2(e.usd), txHash: e.txHash as `0x${string}`, blockNumber: e.blockNumber });
  }
  const ledger = [...folded.values()].slice(0, LEDGER_MAX);

  /* ----------------------------- verification ----------------------------- */
  let verifiedTx = 0;
  let revertedTx = 0;
  let pendingTx = 0;
  for (const h of x.referenced) {
    const r = input.receipts.get(h);
    if (!r || r.status === "pending") pendingTx += 1;
    else if (r.status === "success") verifiedTx += 1;
    else revertedTx += 1;
  }
  for (const r of rollups) {
    verifiedTx += r.verifiedTx;
    revertedTx += r.revertedTx;
  }

  return {
    generatedAt: now,
    windows,
    trading: {
      byProvider: [...b.byProvider.entries()].map(([provider, v]) => ({ provider, count: v.count, usd: round2(v.usd) })).sort((a, b2) => b2.usd - a.usd || b2.count - a.count),
      byAsset: byAsset.sort((a, b2) => b2.buyUsd + b2.sellUsd - (a.buyUsd + a.sellUsd)),
      withoutUsd: x.withoutUsd,
      integratorFeeUsd: round2(b.feeUsd),
    },
    strategies: {
      executions: { ...x.execStats, usd: round2(x.execStats.usd) },
      autoInvest: { ...x.autoInvest, usd: round2(x.autoInvest.usd) },
      manualPlans: { ...x.manualPlans, usd: round2(x.manualPlans.usd) },
      community: { baskets: input.baskets.length, votes: input.baskets.reduce((s, bk) => s + bk.votes, 0), clones: input.baskets.reduce((s, bk) => s + bk.clones, 0) },
    },
    gifts: {
      direct: { ...x.direct, valueUsdToday: round2(x.direct.valueUsdToday) },
      links: { ...x.links, valueUsdToday: round2(x.links.valueUsdToday) },
      pools: { ...x.poolStats, sharesValueUsdToday: round2(x.poolStats.sharesValueUsdToday) },
    },
    earn: {
      deposits: { count: earn.deposits.count, usd: round2(earn.deposits.usd) },
      withdrawals: { count: earn.withdrawals.count, usd: round2(earn.withdrawals.usd) },
      byProvider: [...b.earnByProvider.entries()].map(([provider, v]) => ({ provider, deposits: v.deposits, depositUsd: round2(v.depositUsd), withdrawals: v.withdrawals, withdrawalUsd: round2(v.withdrawalUsd) })).sort((a, b2) => b2.depositUsd - a.depositUsd),
      liquidity: {
        added: { count: b.liquidity.added.count, usd: round2(b.liquidity.added.usd) },
        removed: { count: b.liquidity.removed.count, usd: round2(b.liquidity.removed.usd) },
        collected: { count: b.liquidity.collected.count, usd: round2(b.liquidity.collected.usd) },
      },
    },
    people: {
      transactingWallets: allWallets.size,
      knownWallets,
      profiles: input.profiles.length,
      publicProfiles: input.profiles.filter((p) => p.isPublic).length,
      watchlistEntries: input.watchlists.entries,
      watchlistWallets: input.watchlists.wallets,
      portfolioWallets: input.portfolioWallets,
      aiBriefs: input.digests.count,
      aiSpendUsd: round2(input.aiSpendUsd),
    },
    daily,
    ledger,
    verification: { verified: verifiedTx, reverted: revertedTx, pending: pendingTx, withoutTx: x.withoutTx, duplicatesCollapsed: x.duplicatesCollapsed, disowned: x.disownedRecords, unchecked: input.unchecked ?? 0 },
    rollup: { days: rollups.length, through: rollups.length ? rollups[rollups.length - 1]!.day : null, liveSince: liveSince > 0 ? liveSince : null },
  };
}
