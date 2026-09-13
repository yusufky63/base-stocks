import { z } from "zod";
import type { Address } from "viem";
import { route, json, parseBody, parseQuery, addressSchema } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { b20Guard } from "@/services/b20-guard-service";
import { buildPoolViews, listPublicPools } from "@/services/pool-service";
import { gateSignerAddress, isGateSignerConfigured } from "@/lib/pool/gate";
import { checkPoolCreate, poolCreateSchema } from "@/lib/pool/create";
import { GIFT_POOL_ADDRESS, isPoolDeployed, onchainIdFor, poolMemo, poolSalt } from "@/lib/pool";
import { requireOwner } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import type { PoolRecord } from "@/domain/pool";

/**
 * Create the app-side record for a pool. Nothing is locked yet: the client takes the returned
 * `salt` and `memo`, sends `approve` + `create` to GiftPool, then PATCHes the transaction hash
 * back. The record is a draft until it does.
 *
 * The creator signs in first. A draft is a row anyone could otherwise write under any wallet, and
 * the creator's own pool list is served by session, so the session has to exist anyway.
 */
export const POST = route({ rateLimit: { key: "pools.write", limit: 20, windowMs: 60_000, durable: true } }, async (req) => {
  if (!isPoolDeployed()) throw new AppError("POOL_UNAVAILABLE", "Gift pools are not enabled on this deployment yet.", 503);
  const body = await parseBody(req, poolCreateSchema);
  requireOwner(req, body.creator);

  const signer = gateSignerAddress();
  const { gateAddress } = checkPoolCreate(body, { now: Date.now(), gateSigner: signer && isGateSignerConfigured() ? signer : null });

  // The deposit is creator → pool, so the guard checks exactly that path for every leg.
  const warnings: string[] = [];
  for (const leg of body.legs) {
    const res = await b20Guard.preSendCheck({ assetAddress: leg.token, sender: body.creator, recipient: GIFT_POOL_ADDRESS as Address });
    warnings.push(...res.warnings);
  }

  const id = `pool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const record: PoolRecord = {
    id,
    onchainId: onchainIdFor(body.creator, id),
    // The contract the browser is about to fund. Stamped here, not sent by the client, so the
    // record and the transaction can only ever name the same deployment.
    contractAddress: GIFT_POOL_ADDRESS as Address,
    creator: body.creator,
    gateMode: body.gateMode,
    gateAddress,
    slots: body.slots,
    legs: body.legs,
    expiry: body.expiry,
    lockedUntil: body.lockedUntil,
    visibility: body.visibility,
    verified: false,
    title: body.title,
    message: body.message,
    quests: body.quests,
    memo: poolMemo(id),
    status: "draft",
    createdAt: Date.now(),
  };
  await getRepos().pools.create(record);
  return json({ pool: record, salt: poolSalt(id), warnings: Array.from(new Set(warnings)) }, { status: 201 });
});

const listSchema = z.object({ creator: addressSchema.optional(), scope: z.enum(["public", "mine"]).optional(), limit: z.coerce.number().int().min(1).max(60).optional() });

/**
 * `?creator=0x…` for a creator's own pools (unlisted ones included, so only that wallet's session
 * may ask), otherwise the public directory.
 */
export const GET = route({ rateLimit: { key: "pools.read", limit: 120, windowMs: 60_000 } }, async (req) => {
  const { creator, limit } = parseQuery(req, listSchema);
  if (creator) {
    requireOwner(req, creator);
    const records = await getRepos().pools.listByCreator(creator).catch(() => []);
    return json({ pools: await buildPoolViews(records.filter((r) => r.status !== "draft")) });
  }
  return json({ pools: await listPublicPools(limit ?? 40) }, { cacheSeconds: 20, staleSeconds: 120 });
});
