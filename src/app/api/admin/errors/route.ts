import { z } from "zod";
import { route, json, parseQuery, requireAdmin } from "@/lib/api";
import { serverEnv } from "@/config/env";
import { clearErrors, recentErrors } from "@/lib/error-sink";

const querySchema = z.object({
  hours: z.coerce.number().int().min(1).max(168).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  /** DELETE: one fingerprint, or every row older than this many hours. Neither means "all of them". */
  fingerprint: z.string().min(4).max(64).optional(),
  olderThanHours: z.coerce.number().int().min(0).max(168).optional(),
});

/**
 * Admin: the recorded errors, with their stacks, and a way to forget them.
 *
 * `/api/health` carries a short list for the monitor; this is the console's view — a longer
 * window, the stack for the one you are reading, and a delete so a list you have worked through
 * stops competing for attention with what is still breaking.
 */
export const GET = route({}, async (req) => {
  requireAdmin(req, serverEnv().ADMIN_API_TOKEN);
  const { hours, limit } = parseQuery(req, querySchema);
  const errors = await recentErrors(limit ?? 50, (hours ?? 24) * 3600_000);
  return json({ hours: hours ?? 24, errors });
});

export const DELETE = route({ rateLimit: { key: "admin.errors", limit: 30, windowMs: 60_000 } }, async (req) => {
  requireAdmin(req, serverEnv().ADMIN_API_TOKEN);
  const { fingerprint, olderThanHours } = parseQuery(req, querySchema);
  const cleared = await clearErrors({ fingerprint, olderThan: olderThanHours !== undefined ? Date.now() - olderThanHours * 3600_000 : undefined });
  return json({ ok: true, cleared });
});
