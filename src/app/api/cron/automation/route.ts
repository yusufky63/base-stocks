import { route, json, requireCron } from "@/lib/api";
import { serverEnv } from "@/config/env";
import { runDuePlans } from "@/services/auto-invest-keeper";

export const maxDuration = 60;

/**
 * The keeper tick. Vercel Cron (vercel.json) and the GitHub Actions schedule
 * (.github/workflows/keeper.yml) both call this with `Authorization: Bearer <CRON_SECRET>`; a
 * `POST` from either works the same way. Overlapping ticks are harmless: a plan is locked while it
 * runs, and the contract refuses a second run inside the cadence regardless.
 */
async function tick(req: Request): Promise<Response> {
  requireCron(req, serverEnv().CRON_SECRET);
  const report = await runDuePlans();
  return json({ ok: true, ...report });
}

export const GET = route({}, tick);
export const POST = route({}, tick);
