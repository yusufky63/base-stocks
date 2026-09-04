import { z } from "zod";
import type { Hash } from "viem";
import { route, json, parseBody, hashSchema } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { buildPoolView, getPoolView, requirePool } from "@/services/pool-service";
import { sessionAddress } from "@/lib/auth/session";
import { serverEnv } from "@/config/env";
import { AppError } from "@/lib/errors";
import type { PoolRecord } from "@/domain/pool";

const patchSchema = z.object({
  txHash: hashSchema.optional(),
  status: z.enum(["submitted", "live", "cancelled", "expired", "failed"]).optional(),
  visibility: z.enum(["public", "unlisted"]).optional(),
  title: z.string().max(80).optional(),
  message: z.string().max(280).optional(),
  /** Admin only, with `x-admin-token`: promotes a pool in the public directory. */
  verified: z.boolean().optional(),
});

/** Public view of a pool: the record, its live onchain state, priced legs and the claim count. */
export const GET = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "pools.read", limit: 120, windowMs: 60_000 } }, async (_req, { params }) => {
  const { id } = await params;
  const view = await getPoolView(id);
  if (!view) throw new AppError("NOT_FOUND", "Pool not found", 404);
  return json({ view }, { cacheSeconds: 10, staleSeconds: 60 });
});

/**
 * Records what the wallet did (`txHash`, `status`) and lets the creator edit presentation.
 *
 * Transaction bookkeeping needs no signature — it is an index, never proof, and the chain is
 * re-read on every view. Anything that changes who sees the pool does: publishing needs the
 * creator's session, and `verified` needs the admin token.
 */
export const PATCH = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "pools.write", limit: 60, windowMs: 60_000, durable: true } }, async (req, { params }) => {
  const { id } = await params;
  const body = await parseBody(req, patchSchema);
  const record = await requirePool(id);

  const patch: Partial<PoolRecord> = {};
  if (body.txHash) patch.txHash = body.txHash as Hash;
  if (body.status) patch.status = body.status;

  const wantsOwnerChange = body.visibility !== undefined || body.title !== undefined || body.message !== undefined;
  if (wantsOwnerChange) {
    const signedIn = sessionAddress(req);
    if (!signedIn || signedIn.toLowerCase() !== record.creator.toLowerCase()) {
      throw new AppError("UNAUTHORIZED", "Sign in with the creating wallet to change how this pool is shown.", 401);
    }
    if (body.visibility !== undefined) patch.visibility = body.visibility;
    if (body.title !== undefined) patch.title = body.title;
    if (body.message !== undefined) patch.message = body.message;
  }

  if (body.verified !== undefined) {
    const token = serverEnv().ADMIN_API_TOKEN;
    const provided = req.headers.get("x-admin-token");
    if (!token || provided !== token) throw new AppError("UNAUTHORIZED", "Admin token required to verify a pool.", 401);
    patch.verified = body.verified;
  }

  const updated = await getRepos().pools.update(id, patch);
  if (!updated) throw new AppError("NOT_FOUND", "Pool not found", 404);
  return json({ view: await buildPoolView(updated) });
});
