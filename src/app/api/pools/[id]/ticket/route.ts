import type { Address } from "viem";
import { route, json } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { requirePool, readPoolOnchain } from "@/services/pool-service";
import { questProof, readAttestations, toQuestStatus, verifyQuests } from "@/services/quest-service";
import { b20Guard } from "@/services/b20-guard-service";
import { issueTicket } from "@/lib/pool/gate";
import { GIFT_POOL_ADDRESS } from "@/lib/pool";
import { requireSession } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import type { PoolClaim, PoolRecord } from "@/domain/pool";

/**
 * Checks that a pool can still pay this address, using the chain as the authority. Returns the
 * onchain state so callers do not read it twice.
 */
async function assertClaimable(pool: PoolRecord, claimant: Address) {
  if (pool.gateMode !== "signer") throw new AppError("BAD_REQUEST", "This pool does not use quest tickets.", 400);
  const onchain = await readPoolOnchain(pool.onchainId);
  if (!onchain?.exists) throw new AppError("NOT_FOUND", "This pool is not funded onchain yet.", 404);
  if (onchain.cancelled) throw new AppError("POOL_CLOSED", "The creator closed this pool.", 409);
  if (Date.now() > onchain.expiry) throw new AppError("POOL_CLOSED", "The claim window for this pool has closed.", 409);
  if (onchain.remainingSlots === 0) throw new AppError("POOL_EMPTY", "Every share in this pool has been claimed.", 409);
  const already = await getRepos().poolClaims.get(pool.id, claimant).catch(() => null);
  if (already?.status === "confirmed" || already?.status === "reconciled") {
    throw new AppError("ALREADY_CLAIMED", "This wallet already claimed its share of this pool.", 409);
  }
  return onchain;
}

/** Checklist for the signed-in wallet: what is done, what is missing, and where to go do it. */
export const GET = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "pools.quests", limit: 60, windowMs: 60_000 } }, async (req, { params }) => {
  const claimant = requireSession(req);
  const pool = await requirePool((await params).id);
  const claim = await getRepos().poolClaims.get(pool.id, claimant).catch(() => null);
  const results = await verifyQuests(pool.quests, claimant, readAttestations(claim?.questProof));
  return json({
    quests: results.map(toQuestStatus),
    eligible: results.every((r) => r.done),
    alreadyClaimed: claim?.status === "confirmed" || claim?.status === "reconciled",
  });
});

/**
 * Issues a claim ticket for the signed-in wallet — the one place where quest verification and the
 * campaign signer meet. The signature is only produced once every step passes, is bound to this
 * pool and this recipient, and expires in fifteen minutes.
 */
export const POST = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "pools.ticket", limit: 10, windowMs: 60_000, durable: true } }, async (req, { params }) => {
  const claimant = requireSession(req);
  const pool = await requirePool((await params).id);
  await assertClaimable(pool, claimant);

  const repos = getRepos();
  const existing = await repos.poolClaims.get(pool.id, claimant).catch(() => null);
  const attested = readAttestations(existing?.questProof);
  const results = await verifyQuests(pool.quests, claimant, attested);
  const failed = results.filter((r) => !r.done);
  if (failed.length > 0) {
    throw new AppError("QUEST_INCOMPLETE", failed[0]!.detail ?? `Not done yet: ${failed[0]!.label}.`, 403, {
      quests: results.map(toQuestStatus),
    });
  }

  // The issuer can still refuse the transfer: check the receiver policy for every leg before the
  // claimant spends gas on a transaction that would revert.
  for (const leg of pool.legs) {
    await b20Guard.preSendCheck({ assetAddress: leg.token, sender: GIFT_POOL_ADDRESS as Address, recipient: claimant });
  }

  const proof = questProof(results, attested);
  if (existing) {
    await repos.poolClaims.update(pool.id, claimant, { questProof: proof }).catch(() => null);
  } else {
    const claim: PoolClaim = { poolId: pool.id, claimant, status: "issued", questProof: proof, createdAt: Date.now() };
    await repos.poolClaims.claimOnce(claim).catch(() => null);
  }

  const ticket = await issueTicket(pool.onchainId, claimant);
  return json({ ticket, poolId: pool.onchainId });
});
