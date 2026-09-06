import { z } from "zod";
import { route, json, parseQuery } from "@/lib/api";
import { serverEnv } from "@/config/env";
import { AppError } from "@/lib/errors";
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

export const maxDuration = 60;

const JOBS = ["discovery", "status", "pools", "verify", "earn", "index", "rollup", "stats", "sweep"] as const;
type Job = (typeof JOBS)[number];

/** `blocks` narrows the transfer sweep for one call, so a stalled cursor can be walked forward by hand. */
const querySchema = z.object({ job: z.enum([...JOBS, "all"]).optional(), blocks: z.coerce.number().int().min(100).max(200_000).optional() });

/**
 * Scheduled maintenance, one job per request so none eats another's budget.
 *
 * Vercel's daily cron calls `?job=all` (the sequence, inside one 60 s budget as before); the
 * GitHub Actions schedule calls the time-sensitive jobs one by one every fifteen minutes:
 * `index` (stock transfers touching indexed wallets), `verify` (records filed while their receipt
 * was pending), `earn` (venue events), `pools` (`PoolClaimed` logs), `stats` (recompute and
 * share) and `status` (probes). `discovery` and `sweep` (expired cache and rate-limit rows) are
 * daily work. Every call carries `Authorization: Bearer <CRON_SECRET>`; anyone else gets 401.
 */
const DEFAULT_SWEEP_BLOCKS = 10_000;

/** Per-request options, passed down rather than held in module state (instances serve in parallel). */
interface JobOpts {
  sweepBlocks: number;
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
  // A run has to finish inside `maxDuration`, and a degraded RPC turns one chunk into several
  // calls, so the sweep gets a block budget rather than the whole backlog. Base mines ~450 blocks
  // a minute and this runs every fifteen, so this keeps up with room to spare and eats a stalled
  // cursor's backlog over a few runs; `more` in the result says when there is ground left.
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
    return { sharedCache: shared ?? null, rateWindows };
  },
};

async function runJob(job: Job, opts: JobOpts): Promise<{ job: Job; ms: number; result?: unknown; error?: string }> {
  const started = Date.now();
  try {
    const result = await runners[job](opts);
    return { job, ms: Date.now() - started, result };
  } catch (err) {
    return { job, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

export const GET = route({}, async (req) => {
  const secret = serverEnv().CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || auth !== `Bearer ${secret}`) throw new AppError("UNAUTHORIZED", "Cron secret required", 401);
  const { job, blocks } = parseQuery(req, querySchema);
  const opts: JobOpts = { sweepBlocks: blocks ?? DEFAULT_SWEEP_BLOCKS };
  const started = Date.now();
  const jobs: Job[] = !job || job === "all" ? [...JOBS] : [job];
  const results = [];
  for (const j of jobs) results.push(await runJob(j, opts));
  return json({ ok: results.every((r) => !r.error), ms: Date.now() - started, results });
});
