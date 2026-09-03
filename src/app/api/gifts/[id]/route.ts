import { z } from "zod";
import { route, json, parseBody, addressSchema, hashSchema } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { getGiftReceipt } from "@/services/gift-service";
import { AppError } from "@/lib/errors";
import type { Hash } from "viem";
import type { GiftRecord } from "@/domain/gift";

const patchSchema = z.object({
  txHash: hashSchema.optional(),
  status: z.enum(["draft", "submitted", "confirmed", "failed", "claimed", "reclaimed"]).optional(),
  /** Claim-link: the claim transaction and who received the tokens. */
  claimTx: hashSchema.optional(),
  claimedBy: addressSchema.optional(),
});

/** Public receipt (sender, recipient, amount, message, tx) for a gift that was submitted onchain. */
export const GET = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "gifts.read", limit: 120, windowMs: 60_000 } }, async (_req, { params }) => {
  const { id } = await params;
  const receipt = await getGiftReceipt(id);
  if (!receipt) throw new AppError("NOT_FOUND", "Gift not found", 404);
  return json({ receipt }, { cacheSeconds: 30, staleSeconds: 300 });
});

export const PATCH = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "gifts.write", limit: 60, windowMs: 60_000 } }, async (req, { params }) => {
  const { id } = await params;
  const body = await parseBody(req, patchSchema);
  const patch: Partial<GiftRecord> = { txHash: body.txHash as Hash | undefined, status: body.status };
  if (body.claimTx) patch.claimTx = body.claimTx as Hash;
  if (body.claimedBy) patch.recipient = body.claimedBy as GiftRecord["recipient"];
  const updated = await getRepos().gifts.update(id, patch);
  if (!updated) throw new AppError("NOT_FOUND", "Gift not found", 404);
  return json({ gift: updated });
});
