import { z } from "zod";
import { route, json, parseBody, hashSchema } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import type { Hash } from "viem";

const patchSchema = z.object({
  txHash: hashSchema.optional(),
  status: z.enum(["submitted", "confirmed", "failed"]).optional(),
});

export const PATCH = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "trades.write", limit: 60, windowMs: 60_000 } }, async (req, { params }) => {
  const { id } = await params;
  const body = await parseBody(req, patchSchema);
  const updated = await getRepos().trades.update(id, { ...body, txHash: body.txHash as Hash | undefined });
  if (!updated) throw new AppError("NOT_FOUND", "Trade record not found", 404);
  return json({ trade: updated });
});
