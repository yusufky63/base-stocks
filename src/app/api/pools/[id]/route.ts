import { z } from "zod";
import type { Hash } from "viem";
import { route, json, parseBody, hashSchema } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { buildPoolView, getPoolView, poolFundingPatch, requirePool } from "@/services/pool-service";
import { verdictError, verifyPoolCancel, verifyPoolCreate } from "@/services/tx-verify-service";
import { gateSignerAddress, isGateSignerConfigured } from "@/lib/pool/gate";
import { sessionAddress } from "@/lib/auth/session";
import { serverEnv } from "@/config/env";
import { AppError } from "@/lib/errors";
import type { PoolRecord } from "@/domain/pool";

const patchSchema = z.object({
  /** The funding transaction; or, with `status: "cancelled"`, the cancel transaction. */
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
 * Records what the wallet did and lets the creator edit presentation.
 *
 * The funding hash is matched to a `PoolCreated` log for this pool by this creator before it is
 * kept, and the chain's gate, slots, expiry, lock and legs replace the draft's (a receipt not in
 * yet leaves the pool pending for the verification sweep). A cancel reported with its hash is
 * matched to `PoolCancelled`. Everything else — a status the creator reports, how the pool is
 * shown — needs the creator's session, and `verified` needs the admin token. The chain is re-read
 * on every view regardless.
 */
export const PATCH = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "pools.write", limit: 60, windowMs: 60_000, durable: true } }, async (req, { params }) => {
  const { id } = await params;
  const body = await parseBody(req, patchSchema);
  const record = await requirePool(id);
  const signedIn = sessionAddress(req);
  const isCreator = !!signedIn && signedIn.toLowerCase() === record.creator.toLowerCase();

  const patch: Partial<PoolRecord> = {};
  if (body.status === "cancelled" && body.txHash) {
    if (!isCreator) throw new AppError("UNAUTHORIZED", "Sign in with the creating wallet to close this pool.", 401);
    const v = await verifyPoolCancel(record, body.txHash as Hash);
    if (!v.ok && v.state !== "pending") {
      const e = verdictError(v);
      throw new AppError(e.code, e.message, e.status);
    }
    // Proven, or the creator's word while the receipt is on its way; the view re-reads the chain anyway.
    patch.status = "cancelled";
  } else if (body.txHash) {
    // Pool ids are in the public directory. A pool the chain has already matched to its funding
    // transaction may only be pointed at another one by its creator, and never by a receipt that
    // is not in yet.
    const sameHash = record.txHash?.toLowerCase() === body.txHash.toLowerCase();
    if (record.verifiedAt && !sameHash && !isCreator) throw new AppError("UNAUTHORIZED", "This pool is already matched to its transaction. Sign in with the creating wallet to change it.", 401);
    const settled = await settlePoolFunding(record, body.txHash as Hash);
    if (!record.verifiedAt || settled.verifiedAt) Object.assign(patch, settled);
  } else if (body.status !== undefined) {
    if (!isCreator) throw new AppError("UNAUTHORIZED", "Sign in with the creating wallet to change this pool's state.", 401);
    patch.status = body.status;
  }

  const wantsOwnerChange = body.visibility !== undefined || body.title !== undefined || body.message !== undefined;
  if (wantsOwnerChange) {
    if (!isCreator) throw new AppError("UNAUTHORIZED", "Sign in with the creating wallet to change how this pool is shown.", 401);
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

/**
 * Match the funding hash to this pool's own `PoolCreated`; the chain's terms overwrite the
 * draft's. Pending receipts are settled by the sweep.
 */
export async function settlePoolFunding(pool: PoolRecord, txHash: Hash): Promise<Partial<PoolRecord>> {
  const signer = gateSignerAddress();
  return poolFundingPatch(pool, txHash, await verifyPoolCreate(pool, txHash), signer && isGateSignerConfigured() ? signer : null);
}
