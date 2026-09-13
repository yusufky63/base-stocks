import { syncDiscoveredAssets } from "@/services/b20-asset-service";
import { getStatusReport } from "@/services/status-service";
import { sweepOpenPools } from "@/services/pool-service";
import { sweepEarn } from "@/services/earn-reconcile-service";
import { sweepTransfers } from "@/services/chain-index-service";
import { verifyPendingRecords } from "@/services/verify-records-service";
import { getPlatformStats, rollupStats } from "@/services/stats-service";
import { getSharedStore } from "@/lib/shared-store";
import { invalidate } from "@/lib/cache";
import { getSupabaseAdmin } from "@/db/supabase";
import { pruneErrors } from "@/lib/error-sink";

/**
 * The maintenance jobs, in one place because two callers need them.
 *
 * The scheduler (`/api/cron/refresh`, authorized by `CRON_SECRET`) runs them on a timetable; the
 * admin console (`/api/admin/jobs`, authorized by the admin token) runs one on demand, which is
 * what you want during an incident — a stalled index cursor is walked forward by hand, a
 * reconciliation is re-run after a provider outage — without pasting a shared cron secret into a
 * browser. Both go through `runJob`, so what an admin triggers is exactly what the schedule runs.
 */
export const JOBS = ["discovery", "status", "pools", "verify", "earn", "index", "rollup", "stats", "sweep"] as const;
export type Job = (typeof JOBS)[number];

/** Shown in the admin console next to each job's button, so nobody has to read this file to use it. */
export const JOB_DESCRIPTIONS: Record<Job, string> = {
  discovery: "Scan B20Created for new tokenized stocks and record them as discovered.",
  status: "Run the service probes behind the Status page.",
  pools: "Sweep PoolClaimed logs so gift pools show what has been claimed.",
  verify: "Re-check records filed while their receipt was still pending.",
  earn: "Reconcile Earn positions against venue events.",
  index: "Advance the stock-transfer index cursor (sized by `blocks`).",
  rollup: "Reduce finished days to stored rollups so statistics read less.",
  stats: "Recompute platform statistics and share them.",
  sweep: "Drop expired shared-cache entries and old rate-limit windows.",
};

/**
 * A run has to finish inside `maxDuration`, so the sweep gets a block budget rather than the whole
 * backlog. Measured on production: 5k blocks is ~19k transfer logs and ~20 s, while 10k and 20k
 * timed out. Base's two-second blocks mean ~450 arrive between runs, so this default keeps up ten
 * times over and still eats a stalled cursor's backlog.
 */
export const DEFAULT_SWEEP_BLOCKS = 5_000;

/** Per-request options, passed down rather than held in module state (instances serve in parallel). */
export interface JobOpts {
  sweepBlocks: number;
}

export interface JobRun {
  job: Job;
  ms: number;
  result?: unknown;
  error?: string;
}

const runners: Record<Job, (o: JobOpts) => Promise<unknown>> = {
  discovery: () => syncDiscoveredAssets({ lookbackBlocks: 120_000n }),
  status: async () => {
    const s = await getStatusReport();
    return { overall: s.overall, checks: s.checks.length };
  },
  pools: () => sweepOpenPools(),
  verify: () => verifyPendingRecords(),
  earn: () => sweepEarn(),
  // `more` says when there is ground left, and a caller-supplied budget sizes a catch-up run.
  index: (o) => sweepTransfers({ maxBlocks: BigInt(o.sweepBlocks) }),
  // Finished days are reduced to stored rollups before the statistics are recomputed, so the
  // recomputation reads only the recent days' records.
  rollup: async () => {
    const r = await rollupStats();
    if (r.written.length) invalidate("stats:");
    return { written: r.written.length, through: r.through };
  },
  stats: async () => {
    const s = await getPlatformStats();
    return { generatedAt: s.generatedAt, verified: s.verification.verified };
  },
  sweep: async () => {
    const shared = await getSharedStore()?.sweep().catch(() => -1);
    // Durable rate-limit windows (key "rl:*") accumulate one row per window; sweep anything older than two days.
    const sb = getSupabaseAdmin();
    let rateWindows = 0;
    if (sb) {
      const cutoff = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const { data, error } = await sb.from("ai_usage").delete().like("key", "rl:%").lt("day", cutoff).select("key");
      if (error) console.warn("[cron] rl sweep:", error.message);
      rateWindows = (data ?? []).length;
    }
    // --- Retention (added 2026-09-13): rows nobody reads again. ---
    // Error rows older than a fortnight, and the daily AI counters (ip:, wallet:, svc:, global)
    // older than a week; the monthly spend rows carry a first-of-month `day` and a week is enough
    // to keep the current month's. The `rl:` windows were handled above.
    let errorRows = 0;
    let aiRows = 0;
    if (sb) {
      errorRows = await pruneErrors(14 * 24 * 3600 * 1000).catch(() => 0);
      const aiCutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const { data: aiGone, error: aiErr } = await sb.from("ai_usage").delete().not("key", "like", "rl:%").lt("day", aiCutoff).select("key");
      if (aiErr) console.warn("[cron] ai_usage sweep:", aiErr.message);
      aiRows = (aiGone ?? []).length;
    }
    return { sharedCache: shared ?? null, rateWindows, errorRows, aiRows };
  },
};

/** One job, timed, with a thrown error turned into a reported one: a failing job never aborts a run. */
export async function runJob(job: Job, opts: JobOpts): Promise<JobRun> {
  const started = Date.now();
  try {
    const result = await runners[job](opts);
    return { job, ms: Date.now() - started, result };
  } catch (err) {
    return { job, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Jobs in order, one at a time, so none eats another's budget. */
export async function runJobs(jobs: readonly Job[], opts: JobOpts): Promise<JobRun[]> {
  const results: JobRun[] = [];
  for (const j of jobs) results.push(await runJob(j, opts));
  return results;
}
