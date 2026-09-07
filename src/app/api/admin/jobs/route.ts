import { z } from "zod";
import { route, json, parseBody, requireAdmin } from "@/lib/api";
import { serverEnv } from "@/config/env";
import { JOBS, JOB_DESCRIPTIONS, DEFAULT_SWEEP_BLOCKS, runJob } from "@/services/maintenance-service";

/** A sweep or a discovery scan reads a lot of chain; give it the whole serverless budget. */
export const maxDuration = 60;

const bodySchema = z.object({
  job: z.enum(JOBS),
  /** Blocks the transfer sweep may read this call; the cursor carries the rest to the next one. */
  blocks: z.number().int().min(100).max(200_000).optional(),
});

/**
 * Admin: run one maintenance job now.
 *
 * The same jobs the scheduler runs, reachable with the admin token instead of `CRON_SECRET` — so
 * walking a stalled index cursor forward or re-running a reconciliation after a provider outage
 * is a button in the console rather than a shared cron secret pasted into a terminal. One job per
 * call, because a run has to finish inside `maxDuration`; the full sequence stays the scheduler's
 * job. Rate-limited so a held-down button cannot pile sweeps onto each other.
 */
export const GET = route({}, async (req) => {
  requireAdmin(req, serverEnv().ADMIN_API_TOKEN);
  return json({ jobs: JOBS.map((job) => ({ job, description: JOB_DESCRIPTIONS[job] })), defaultSweepBlocks: DEFAULT_SWEEP_BLOCKS });
});

export const POST = route({ rateLimit: { key: "admin.jobs", limit: 20, windowMs: 60_000 } }, async (req) => {
  requireAdmin(req, serverEnv().ADMIN_API_TOKEN);
  const { job, blocks } = await parseBody(req, bodySchema);
  const run = await runJob(job, { sweepBlocks: blocks ?? DEFAULT_SWEEP_BLOCKS });
  return json({ ok: !run.error, ...run });
});
