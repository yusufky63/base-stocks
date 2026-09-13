import { z } from "zod";
import type { Address } from "viem";
import { addressSchema } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { isXPostUrl, normalizeXHandle } from "@/content/social";
import { isHttpUrl } from "@/lib/url";
import { MAX_POOL_DURATION_S, MAX_POOL_LEGS, MAX_POOL_QUESTS, MAX_POOL_SLOTS, ZERO_ADDRESS } from "./index";

/**
 * What a pool-creation request has to satisfy before anything is written. Pure, so the rules are
 * testable without a request, a database or a session; the route adds those around it.
 */
const xHandleSchema = z
  .string()
  .trim()
  .transform((v) => normalizeXHandle(v))
  .refine((v) => v.length >= 1, "Enter an X handle");
const xPostSchema = z
  .string()
  .trim()
  .url()
  .refine((v) => isXPostUrl(v), "Paste the link to a post on X, not a profile");

export const questSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sign-in") }),
  z.object({ type: z.literal("hold-basename") }),
  z.object({ type: z.literal("hold-asset"), assetAddress: addressSchema, minRawAmount: z.string().regex(/^\d+$/) }),
  z.object({
    type: z.literal("buy-asset"),
    assetAddress: addressSchema,
    minUsd: z.number().positive().max(100_000),
    withinDays: z.number().int().min(1).max(90).optional(),
  }),
  // Self-declared X steps: the claimant confirms these about themselves (see quest-service).
  z.object({ type: z.literal("follow-bstocks") }),
  z.object({ type: z.literal("follow-x"), handle: xHandleSchema }),
  z.object({ type: z.literal("repost-x"), tweetUrl: xPostSchema }),
  z.object({ type: z.literal("like-x"), tweetUrl: xPostSchema }),
  z.object({
    type: z.literal("visit-url"),
    // `.url()` alone would accept `javascript:`; these links go to `window.open`.
    url: z.string().trim().max(500).refine(isHttpUrl, "Links must start with https://"),
    label: z.string().trim().max(60).optional(),
  }),
]);

export const poolCreateSchema = z.object({
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
  quests: z.array(questSchema).max(MAX_POOL_QUESTS).default([]),
});

export type PoolCreateBody = z.infer<typeof poolCreateSchema>;

/**
 * The rules a parsed body still has to pass, and the gate address the contract will store.
 * Throws the same `AppError`s the route used to, so the client copy is unchanged.
 */
export function checkPoolCreate(body: PoolCreateBody, env: { now: number; gateSigner: Address | null }): { gateAddress: Address } {
  if (body.expiry <= env.now || body.expiry > env.now + MAX_POOL_DURATION_S * 1000) {
    throw new AppError("BAD_REQUEST", "The claim window must end within the next year.", 400);
  }
  if (body.lockedUntil > body.expiry) throw new AppError("BAD_REQUEST", "A lock cannot outlast the claim window.", 400);

  const tokens = body.legs.map((l) => l.token.toLowerCase());
  if (new Set(tokens).size !== tokens.length) throw new AppError("BAD_REQUEST", "Each stock can only appear once in a pool.", 400);
  if (body.legs.some((l) => BigInt(l.amountPerClaim) <= 0n)) throw new AppError("BAD_REQUEST", "Every share must be greater than zero.", 400);

  if (body.gateMode === "link") {
    if (!body.gateAddress || body.gateAddress === ZERO_ADDRESS) throw new AppError("BAD_REQUEST", "A link pool needs its claim key address.", 400);
    return { gateAddress: body.gateAddress };
  }
  if (body.gateMode === "signer") {
    if (!env.gateSigner) throw new AppError("POOL_UNAVAILABLE", "Quest-gated pools are not enabled on this deployment.", 503);
    if (body.quests.length === 0) throw new AppError("BAD_REQUEST", "A quest pool needs at least one requirement.", 400);
    return { gateAddress: env.gateSigner };
  }
  if (body.quests.length > 0) throw new AppError("BAD_REQUEST", "Quests need a signer-gated pool; an open pool cannot check anything.", 400);
  return { gateAddress: ZERO_ADDRESS };
}
