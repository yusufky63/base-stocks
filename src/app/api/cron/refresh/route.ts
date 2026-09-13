import { z } from "zod";
import { route, json, parseQuery, requireCron } from "@/lib/api";
import { serverEnv } from "@/config/env";
import { JOBS, DEFAULT_SWEEP_BLOCKS, runJobs, type Job } from "@/services/maintenance-service";

export const maxDuration = 60;

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
 *
 * The jobs themselves live in `maintenance-service`, so the admin console can run the same ones.
 */
export const GET = route({}, async (req) => {
  requireCron(req, serverEnv().CRON_SECRET);
  const { job, blocks } = parseQuery(req, querySchema);
  const started = Date.now();
  const jobs: Job[] = !job || job === "all" ? [...JOBS] : [job];
  const results = await runJobs(jobs, { sweepBlocks: blocks ?? DEFAULT_SWEEP_BLOCKS });
  return json({ ok: results.every((r) => !r.error), ms: Date.now() - started, results });
});
