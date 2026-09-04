import { z } from "zod";
import { route, json, parseBody } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { requirePool } from "@/services/pool-service";
import { readAttestations, toQuestStatus, verifyQuests } from "@/services/quest-service";
import { isSelfDeclared } from "@/domain/pool";
import { requireSession } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import type { PoolClaim } from "@/domain/pool";

const attestSchema = z.object({ questIndex: z.number().int().min(0).max(7) });

/**
 * Records the claimant's own confirmation of one X step ("I followed", "I reposted").
 *
 * This is an attestation, not a check: X's free API does not expose follows, reposts or likes, so
 * there is nothing to verify against and the app never says there is. What it does buy is real:
 * the confirmation is tied to a signed-in wallet, stamped with a time, survives a reload, and
 * shows up on the creator's roster marked as declared rather than checked — so a creator knows
 * exactly what they are looking at.
 *
 * Only steps that are self-declared by definition are accepted here; a checked quest cannot be
 * talked into passing.
 */
export const POST = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "pools.attest", limit: 30, windowMs: 60_000, durable: true } }, async (req, { params }) => {
  const claimant = requireSession(req);
  const pool = await requirePool((await params).id);
  const { questIndex } = await parseBody(req, attestSchema);

  const quest = pool.quests[questIndex];
  if (!quest) throw new AppError("BAD_REQUEST", "That step is not part of this pool.", 400);
  if (!isSelfDeclared(quest.type)) throw new AppError("BAD_REQUEST", "That step is checked, not declared — nothing to confirm.", 400);

  const repos = getRepos();
  const existing = await repos.poolClaims.get(pool.id, claimant).catch(() => null);
  if (existing?.status === "confirmed" || existing?.status === "reconciled") {
    throw new AppError("ALREADY_CLAIMED", "This wallet already claimed its share of this pool.", 409);
  }

  const attested = { ...readAttestations(existing?.questProof), [String(questIndex)]: Date.now() };
  const nextProof = { ...(existing?.questProof ?? {}), attested };
  if (existing) {
    await repos.poolClaims.update(pool.id, claimant, { questProof: nextProof }).catch(() => null);
  } else {
    const claim: PoolClaim = { poolId: pool.id, claimant, status: "issued", questProof: nextProof, createdAt: Date.now() };
    await repos.poolClaims.claimOnce(claim).catch(() => null);
  }

  const results = await verifyQuests(pool.quests, claimant, attested);
  return json({ quests: results.map(toQuestStatus), eligible: results.every((r) => r.done) });
});
