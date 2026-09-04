import { z } from "zod";
import type { Hash } from "viem";
import { route, json, parseBody, addressSchema, hashSchema } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { reconcilePool, requirePool } from "@/services/pool-service";
import { reverseResolve } from "@/services/basename-service";
import { sessionAddress } from "@/lib/auth/session";
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
    return json({ claims: [], count: await repos.poolClaims.countByPool(pool.id).catch(() => 0), creatorOnly: true });
  }
  const claims = await repos.poolClaims.listByPool(pool.id).catch(() => []);
  const named = await Promise.all(
    claims.map(async (c) => ({ ...c, basename: await reverseResolve(c.claimant).catch(() => null) })),
  );
  return json({ claims: named, count: claims.length, creatorOnly: false });
});

/**
 * A claim page reporting its own transaction. Unauthenticated on purpose — the claimant may be a
 * brand-new passkey wallet that has never signed in — and treated as a hint, not evidence: the
 * row lands as `confirmed` and only the log sweep promotes it to `reconciled`.
 */
export const POST = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "pools.write", limit: 60, windowMs: 60_000, durable: true } }, async (req, { params }) => {
  const pool = await requirePool((await params).id);
  const body = await parseBody(req, recordSchema);
  const repos = getRepos();

  const patch = { status: "confirmed" as const, txHash: body.txHash as Hash };
  const existing = await repos.poolClaims.get(pool.id, body.claimant).catch(() => null);
  if (existing) {
    await repos.poolClaims.update(pool.id, body.claimant, patch).catch(() => null);
  } else {
    const claim: PoolClaim = { poolId: pool.id, claimant: body.claimant, questProof: {}, createdAt: Date.now(), ...patch };
    await repos.poolClaims.claimOnce(claim).catch(() => null);
  }
  return json({ ok: true }, { status: 201 });
});

/** Pull the roster back into line with the chain. Cheap, idempotent, safe to spam-click. */
export const PUT = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "pools.sync", limit: 6, windowMs: 60_000, durable: true } }, async (_req, { params }) => {
  const pool = await requirePool((await params).id);
  return json(await reconcilePool(pool));
});
