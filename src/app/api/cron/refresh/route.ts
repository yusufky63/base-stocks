import { route, json } from "@/lib/api";
import { serverEnv } from "@/config/env";
import { AppError } from "@/lib/errors";
import { syncDiscoveredAssets } from "@/services/b20-asset-service";
import { getStatusReport } from "@/services/status-service";

export const maxDuration = 60;

/**
 * Scheduled maintenance for serverless hosting, where the in-process timers of
 * `src/instrumentation.ts` die with each instance. Vercel Cron calls this with
 * `Authorization: Bearer <CRON_SECRET>` (see vercel.json); anyone else gets 401.
 * Work: a light B20 discovery scan (new Coinbase stocks land in storage and go live automatically)
 * and one status probe run so the Status page has fresh history.
 */
export const GET = route({}, async (req) => {
  const secret = serverEnv().CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || auth !== `Bearer ${secret}`) throw new AppError("UNAUTHORIZED", "Cron secret required", 401);
  const started = Date.now();
  const discovery = await syncDiscoveredAssets({ lookbackBlocks: 120_000n }).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
  const status = await getStatusReport().catch(() => null);
  return json({ ok: true, ms: Date.now() - started, discovery, status: status ? { overall: status.overall, checks: status.checks.length } : null });
});
