import { z } from "zod";
import { route, json, parseBody, hashSchema } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { getGiftReceipt } from "@/services/gift-service";
import { AppError } from "@/lib/errors";
import type { Hash } from "viem";

const patchSchema = z.object({
  txHash: hashSchema.optional(),
  status: z.enum(["draft", "submitted", "confirmed", "failed"]).optional(),
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
  const updated = await getRepos().gifts.update(id, { ...body, txHash: body.txHash as Hash | undefined });
  if (!updated) throw new AppError("NOT_FOUND", "Gift not found", 404);
  return json({ gift: updated });
});
