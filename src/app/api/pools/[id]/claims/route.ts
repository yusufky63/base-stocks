import { z } from "zod";
import type { Hash } from "viem";
import { route, json, parseBody, addressSchema, hashSchema } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { reconcilePool, requirePool } from "@/services/pool-service";
import { reverseResolve } from "@/services/basename-service";
import { proofSummary } from "@/services/quest-service";
import { requireOwner, sessionAddress } from "@/lib/auth/session";
import { verdictError, verifyPoolClaim } from "@/services/tx-verify-service";
import { AppError } from "@/lib/errors";
import type { PoolClaim } from "@/domain/pool";

const recordSchema = z.object({
  claimant: addressSchema,
  txHash: hashSchema,
});

/**
 * Who claimed. The creator (signed in) sees the full roster with Basenames; everyone else sees
 * the count, which the chain publishes anyway.
 *
 * `status` says how much each row is worth: `issued` is a ticket we handed out, `confirmed` is
 * what a claim page reported, `reconciled` is a row matched against a `PoolClaimed` log. Only the
 * last is proof.
 */
export const GET = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "pools.read", limit: 120, windowMs: 60_000 } }, async (req, { params }) => {
  const pool = await requirePool((await params).id);
  const repos = getRepos();
  const signedIn = sessionAddress(req);
  const isCreator = !!signedIn && signedIn.toLowerCase() === pool.creator.toLowerCase();

  if (!isCreator) {
    // Only rows that are claims (confirmed or matched to a log); tickets the app handed out are not.
    return json({ claims: [], count: await repos.poolClaims.countByPool(pool.id).catch(() => 0), creatorOnly: true });
  }
  const claims = await repos.poolClaims.listByPool(pool.id).catch(() => []);
  const named = await Promise.all(
    claims.map(async (c) => ({
      ...c,
      basename: await reverseResolve(c.claimant).catch(() => null),
      // `checked` separates what the chain proved from what the claimant told us.
      proof: proofSummary(c.questProof, pool.quests),
    })),
  );
  return json({ claims: named, count: claims.filter((c) => c.status !== "issued").length, creatorOnly: false });
});

/**
 * A claim page reporting its own transaction. Unauthenticated on purpose — the claimant may be a
 * brand-new passkey wallet that has never signed in — so the receipt is the evidence: the hash
 * must carry `PoolClaimed` for this pool and this wallet, and then the row lands as `reconciled`
 * straight away. A receipt not in yet keeps the row a ticket (`issued`) carrying the hash for the
 * sweep to prove; it used to become `confirmed`, which counted as a claim and locked the wallet
 * out of the pool, so anyone could lock anyone else out with a made-up hash. One that says
 * something else is refused.
 */
export const POST = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "pools.write", limit: 60, windowMs: 60_000, durable: true } }, async (req, { params }) => {
  const pool = await requirePool((await params).id);
  const body = await parseBody(req, recordSchema);
  const repos = getRepos();

  const v = await verifyPoolClaim(pool, body.claimant, body.txHash as Hash);
  if (!v.ok && v.state !== "pending") {
    const e = verdictError(v);
    throw new AppError(e.code, e.message, e.status);
  }
  const existing = await repos.poolClaims.get(pool.id, body.claimant).catch(() => null);
  // A row the chain already proved, or a report the page made itself, is not unseated by a hash nobody has seen yet.
  if (!v.ok && existing && (existing.status === "reconciled" || existing.status === "confirmed")) return json({ ok: true, verification: existing.status === "reconciled" ? "verified" : "pending" });
  const patch = v.ok ? { status: "reconciled" as const, txHash: body.txHash as Hash, blockNumber: v.blockNumber } : { status: "issued" as const, txHash: body.txHash as Hash };
  if (existing) {
    await repos.poolClaims.update(pool.id, body.claimant, patch).catch(() => null);
  } else {
    const claim: PoolClaim = { poolId: pool.id, claimant: body.claimant, questProof: {}, createdAt: Date.now(), ...patch };
    await repos.poolClaims.claimOnce(claim).catch(() => null);
  }
  return json({ ok: true, verification: v.ok ? "verified" : "pending" }, { status: 201 });
});

/**
 * Pull the roster back into line with the chain. Idempotent, but not free: it is a log scan over
 * up to half a million blocks, so only the creator (signed in) may ask for it; the sweep does the
 * same for everyone on its own schedule.
 */
export const PUT = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "pools.sync", limit: 6, windowMs: 60_000, durable: true } }, async (req, { params }) => {
  const pool = await requirePool((await params).id);
  requireOwner(req, pool.creator);
  return json(await reconcilePool(pool));
});
