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
import { getPlatformStats } from "@/services/stats-service";
import { getSharedStore } from "@/lib/shared-store";
import { getSupabaseAdmin } from "@/db/supabase";

export const maxDuration = 60;

const JOBS = ["discovery", "status", "pools", "verify", "earn", "index", "stats", "sweep"] as const;
type Job = (typeof JOBS)[number];

const querySchema = z.object({ job: z.enum([...JOBS, "all"]).optional() });

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
const runners: Record<Job, () => Promise<unknown>> = {
  discovery: () => syncDiscoveredAssets({ lookbackBlocks: 120_000n }),
  status: async () => {
    const s = await getStatusReport();
    return { overall: s.overall, checks: s.checks.length };
  },
  pools: () => sweepOpenPools(),
  verify: () => verifyPendingRecords(),
  earn: () => sweepEarn(),
  index: () => sweepTransfers(),
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

async function runJob(job: Job): Promise<{ job: Job; ms: number; result?: unknown; error?: string }> {
  const started = Date.now();
  try {
    const result = await runners[job]();
    return { job, ms: Date.now() - started, result };
  } catch (err) {
    return { job, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

export const GET = route({}, async (req) => {
  const secret = serverEnv().CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || auth !== `Bearer ${secret}`) throw new AppError("UNAUTHORIZED", "Cron secret required", 401);
  const { job } = parseQuery(req, querySchema);
  const started = Date.now();
  const jobs: Job[] = !job || job === "all" ? [...JOBS] : [job];
  const results = [];
  for (const j of jobs) results.push(await runJob(j));
  return json({ ok: results.every((r) => !r.error), ms: Date.now() - started, results });
});
