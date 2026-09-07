import { z } from "zod";
import { route, json, parseBody, requireAdmin } from "@/lib/api";
import { serverEnv } from "@/config/env";
import { sweepEarn } from "@/services/earn-reconcile-service";
import { invalidate } from "@/lib/cache";

/** A sweep reads up to a few hundred thousand blocks; give it the whole serverless budget. */
export const maxDuration = 60;

const bodySchema = z.object({
  /** Start here instead of the stored cursor (a backfill). */
  fromBlock: z.number().int().nonnegative().optional(),
  /** Blocks to read this call; the cursor carries the rest to the next call. */
  maxBlocks: z.number().int().min(1_000).max(400_000).optional(),
});

/**
 * Admin: run the Earn reconciliation now. Used for the one-time backfill and after any incident
 * that could have lost records; the daily cron and the statistics run the same sweep on their own.
 */
export const POST = route({ rateLimit: { key: "admin.earn", limit: 10, windowMs: 60_000 } }, async (req) => {
  requireAdmin(req, serverEnv().ADMIN_API_TOKEN);
  const body = await parseBody(req, bodySchema.optional().default({}));
  const result = await sweepEarn({ fromBlock: body.fromBlock !== undefined ? BigInt(body.fromBlock) : undefined, maxBlocks: body.maxBlocks !== undefined ? BigInt(body.maxBlocks) : undefined });
  if (result.added > 0) await invalidate("stats:");
  return json(result);
});
