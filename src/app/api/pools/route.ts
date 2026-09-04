import { z } from "zod";
import type { Address } from "viem";
import { route, json, parseBody, parseQuery, addressSchema } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { b20Guard } from "@/services/b20-guard-service";
import { buildPoolView, listPublicPools } from "@/services/pool-service";
import { gateSignerAddress, isGateSignerConfigured } from "@/lib/pool/gate";
import { GIFT_POOL_ADDRESS, MAX_POOL_LEGS, MAX_POOL_SLOTS, MAX_POOL_DURATION_S, ZERO_ADDRESS, isPoolDeployed, onchainIdFor, poolMemo, poolSalt } from "@/lib/pool";
import { sessionAddress } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import type { PoolRecord } from "@/domain/pool";

const questSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sign-in") }),
  z.object({ type: z.literal("hold-basename") }),
  z.object({ type: z.literal("hold-asset"), assetAddress: addressSchema, minRawAmount: z.string().regex(/^\d+$/) }),
  z.object({
    type: z.literal("buy-asset"),
    assetAddress: addressSchema,
    minUsd: z.number().positive().max(100_000),
    withinDays: z.number().int().min(1).max(90).optional(),
  }),
]);

const createSchema = z.object({
  creator: addressSchema,
  gateMode: z.enum(["open", "link", "signer"]),
  /** `link` pools pass the ephemeral key's ADDRESS; the key itself never leaves the browser. */
  gateAddress: addressSchema.optional(),
  slots: z.number().int().min(1).max(MAX_POOL_SLOTS),
  legs: z
    .array(z.object({ token: addressSchema, amountPerClaim: z.string().regex(/^\d+$/) }))
    .min(1)
    .max(MAX_POOL_LEGS),
  expiry: z.number().int().positive(),
  lockedUntil: z.number().int().min(0).default(0),
  visibility: z.enum(["public", "unlisted"]).default("unlisted"),
  title: z.string().max(80).optional(),
  message: z.string().max(280).optional(),
  quests: z.array(questSchema).max(4).default([]),
});

/**
 * Create the app-side record for a pool. Nothing is locked yet: the client takes the returned
 * `salt` and `memo`, sends `approve` + `create` to GiftPool, then PATCHes the transaction hash
 * back. The record is a draft until it does.
 */
export const POST = route({ rateLimit: { key: "pools.write", limit: 20, windowMs: 60_000, durable: true } }, async (req) => {
  if (!isPoolDeployed()) throw new AppError("POOL_UNAVAILABLE", "Gift pools are not enabled on this deployment yet.", 503);
  const body = await parseBody(req, createSchema);

  const now = Date.now();
  if (body.expiry <= now || body.expiry > now + MAX_POOL_DURATION_S * 1000) {
    throw new AppError("BAD_REQUEST", "The claim window must end within the next year.", 400);
  }
  if (body.lockedUntil > body.expiry) throw new AppError("BAD_REQUEST", "A lock cannot outlast the claim window.", 400);

  const tokens = body.legs.map((l) => l.token.toLowerCase());
  if (new Set(tokens).size !== tokens.length) throw new AppError("BAD_REQUEST", "Each stock can only appear once in a pool.", 400);
  if (body.legs.some((l) => BigInt(l.amountPerClaim) <= 0n)) throw new AppError("BAD_REQUEST", "Every share must be greater than zero.", 400);

  // Resolve the gate the contract will store.
  let gateAddress: Address = ZERO_ADDRESS;
  if (body.gateMode === "link") {
    if (!body.gateAddress || body.gateAddress === ZERO_ADDRESS) throw new AppError("BAD_REQUEST", "A link pool needs its claim key address.", 400);
    gateAddress = body.gateAddress;
  } else if (body.gateMode === "signer") {
    const signer = gateSignerAddress();
    if (!signer || !isGateSignerConfigured()) throw new AppError("POOL_UNAVAILABLE", "Quest-gated pools are not enabled on this deployment.", 503);
    if (body.quests.length === 0) throw new AppError("BAD_REQUEST", "A quest pool needs at least one requirement.", 400);
    gateAddress = signer;
  } else if (body.quests.length > 0) {
    throw new AppError("BAD_REQUEST", "Quests need a signer-gated pool; an open pool cannot check anything.", 400);
  }

  // Listing a pool publicly is the one thing worth proving ownership for — it is the surface a
  // spammer would want. Everything else is recoverable by the creator alone.
  if (body.visibility === "public") {
    const signedIn = sessionAddress(req);
    if (!signedIn || signedIn.toLowerCase() !== body.creator.toLowerCase()) {
      throw new AppError("UNAUTHORIZED", "Sign in with the creating wallet to list a pool publicly.", 401);
    }
  }

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

/** `?creator=0x…` for a creator's own pools, otherwise the public directory. */
export const GET = route({ rateLimit: { key: "pools.read", limit: 120, windowMs: 60_000 } }, async (req) => {
  const { creator, limit } = parseQuery(req, listSchema);
  if (creator) {
    const records = await getRepos().pools.listByCreator(creator).catch(() => []);
    const pools = await Promise.all(records.filter((r) => r.status !== "draft").map((r) => buildPoolView(r)));
    return json({ pools });
  }
  return json({ pools: await listPublicPools(limit ?? 40) }, { cacheSeconds: 20, staleSeconds: 120 });
});
