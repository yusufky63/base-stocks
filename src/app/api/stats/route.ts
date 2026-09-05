import { route, json } from "@/lib/api";
import { getPlatformStats } from "@/services/stats-service";

/** Serverless budget: the first computation after a deploy verifies receipts against the chain. */
export const maxDuration = 60;

/**
 * Platform statistics, public. Aggregates only — no wallet is named; transaction hashes are the
 * proof and are public on Base anyway. Computed at most every five minutes.
 */
export const GET = route({ rateLimit: { key: "stats", limit: 60, windowMs: 60_000 } }, async () => {
  return json(await getPlatformStats(), { cacheSeconds: 120, staleSeconds: 600 });
});
