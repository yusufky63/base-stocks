import type { Hash } from "viem";
import type { DayRollup, PlatformStats } from "@/domain/stats";
import { getRepos } from "@/db/repositories";
import { cached } from "@/lib/cache";
import { monthlySpendUsd } from "@/lib/ai-quota";
import { aggregateStats, buildDayRollup, dayKey, type StatsInput } from "@/lib/stats/aggregate";
import { getAssets } from "./b20-asset-service";
import { getPriceViews } from "./price-service";
import { getReceiptStates } from "./receipt-service";

/**
 * Platform-wide statistics, verified against Base and aggregated by `aggregateStats`.
 *
 * The numbers must be reproducible from the tables, never maintained as counters that drift; and
 * their cost must not grow with the number of records ever written. Both hold at once through
 * **daily rollups**: a finished day is reduced once (`rollupStats`) and stored in `stats_daily`,
 * and the live computation reads only the records of the days after the last rollup. A record
 * is therefore read in full at most a handful of times in its life, and `/stats` at ten thousand
 * records costs what it costs at a hundred.
 */
const CACHE = { ttlMs: 5 * 60_000, staleMs: 60 * 60_000, shared: true };
/** Receipts verified per computation at most; anything beyond is reported as unchecked, not guessed. */
const MAX_RECEIPTS = 3_000;
const DAY_MS = 24 * 3600_000;
/** Days kept live behind the rollup boundary, so the 30-day window and chart never touch a rollup. */
export const LIVE_DAYS = 35;
/** A claim link can be taken up to 90 days after it was funded: its record predates its claim event by that much. */
const GIFT_LOOKBACK_MS = 120 * DAY_MS;
/** A record created a little before a day can still be mined inside it. */
const RECORD_SLACK_MS = 2 * DAY_MS;

export async function getPlatformStats(): Promise<PlatformStats> {
  return cached("stats:platform", CACHE, compute);
}

/**
 * The records whose events can fall in [fromMs, toMs), plus everything needed to value and verify
 * them. The distinct wallet counts come from the database when the functions are installed
 * (`stats_distinct_wallets()`), and from paging the snapshots table when they are not.
 */
async function loadWindow(fromMs: number, toMs: number, now: number): Promise<Omit<StatsInput, "rollups" | "liveSince">> {
  const repos = getRepos();
  const counts = await repos.statsDaily.distinctWallets().catch(() => null);
  const [assets, trades, gifts, executions, earnActions, pools, poolClaims, rules, profiles, baskets, watchlists, portfolioWallets, digests, aiSpendUsd] = await Promise.all([
    getAssets(),
    repos.trades.listBetween(fromMs - RECORD_SLACK_MS, toMs),
    repos.gifts.listBetween(fromMs - GIFT_LOOKBACK_MS, toMs),
    repos.executions.listAll(),
    repos.earnActions.listBetween(fromMs - RECORD_SLACK_MS, toMs),
    repos.pools.listBetween(fromMs - RECORD_SLACK_MS, toMs),
    repos.poolClaims.listBetween(fromMs - RECORD_SLACK_MS, toMs),
    repos.automation.listAll(),
    repos.profiles.listAll(),
    repos.baskets.list({ sort: "new", limit: 1_000 }),
    repos.watchlists.summary(),
    counts ? Promise.resolve(counts.portfolioWallets) : repos.snapshots.countWallets(),
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

  return {
    now,
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
    knownWalletCount: counts?.knownWallets,
  };
}

const startOfDay = (ms: number) => Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate());
const dayStartMs = (day: string) => Date.parse(`${day}T00:00:00.000Z`);

/**
 * The live computation reads records and receipts only. The verification sweep and the Earn
 * reconciliation used to run here first, which made every five-minute recompute a chain scan over
 * every known wallet; both run from the cron on their own schedule (`maintenance-service`), and a
 * record they settle shows up here on the next recompute.
 */
async function compute(): Promise<PlatformStats> {
  const now = Date.now();
  const rollups = await getRepos().statsDaily.list();
  // Everything after the last rollup is live. Rollups are only ever written contiguously from the
  // first day, so "the day after the latest" is the boundary; no rollups means everything is live.
  const liveSince = rollups.length ? dayStartMs(rollups[rollups.length - 1]!.day) + DAY_MS : 0;
  const input = await loadWindow(liveSince, now + DAY_MS, now);
  return aggregateStats({ ...input, rollups, liveSince });
}

/**
 * Reduce finished days to rollups, oldest first, a few per run. A day is finished once it is
 * `LIVE_DAYS` behind: every record of it has long been verified or disowned, so the rollup is
 * final. Returns what was written so the caller can report it.
 */
export async function rollupStats({ maxDays = 14 }: { maxDays?: number } = {}): Promise<{ written: string[]; through: string | null }> {
  const repos = getRepos();
  const now = Date.now();
  const cutoff = startOfDay(now - LIVE_DAYS * DAY_MS); // days strictly before this are finished
  const latest = await repos.statsDaily.latestDay();
  let dayMs: number;
  if (latest) dayMs = dayStartMs(latest) + DAY_MS;
  else {
    // First run: start at the oldest record the app holds.
    const firsts = await Promise.all([repos.trades.listBetween(0, now, 1), repos.gifts.listBetween(0, now, 1), repos.earnActions.listBetween(0, now, 1), repos.pools.listBetween(0, now, 1), repos.poolClaims.listBetween(0, now, 1)]);
    const earliest = Math.min(...firsts.flat().map((r) => r.createdAt).filter((t) => Number.isFinite(t)));
    if (!Number.isFinite(earliest)) return { written: [], through: null };
    dayMs = startOfDay(earliest);
  }
  const written: string[] = [];
  if (dayMs >= cutoff) return { written, through: latest };
  // One load for the whole span of days this run will reduce, then one reduction per day over it:
  // `buildDayRollup` keeps the events whose block time falls on its day, so a wider window costs
  // nothing in accuracy and saves a full set of table reads per day.
  const days = Math.min(maxDays, Math.ceil((cutoff - dayMs) / DAY_MS));
  const input = await loadWindow(dayMs, dayMs + days * DAY_MS, now);
  for (let i = 0; i < days; i++) {
    const day = dayKey(dayMs);
    const rollup: DayRollup = buildDayRollup(input, day);
    await repos.statsDaily.upsert(rollup);
    written.push(day);
    dayMs += DAY_MS;
  }
  return { written, through: written.length ? written[written.length - 1]! : latest };
}
