import { z } from "zod";
import { route, json, parseBody, addressSchema, hashSchema } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import type { Hash } from "viem";

const stepSchema = z.object({
  id: z.string().min(4).max(64),
  assetAddress: addressSchema,
  symbol: z.string().max(16),
  side: z.enum(["buy", "sell"]).default("buy"),
  targetUsd: z.number().nonnegative(),
  sellAmountUsdc: z.string().regex(/^\d+$/),
  sellAmount: z.string().regex(/^\d+$/).optional(),
  provider: z.string().max(32).optional(),
  status: z.enum(["pending", "quoted", "submitted", "confirmed", "failed"]),
  txHash: hashSchema.optional(),
  errorCode: z.string().max(64).optional(),
  errorMessage: z.string().max(300).optional(),
});

const patchSchema = z.object({
  status: z.enum(["READY", "QUOTING", "AWAITING_USER", "EXECUTING", "PARTIALLY_FILLED", "COMPLETE", "FAILED"]).optional(),
  steps: z.array(stepSchema).optional(),
});

export const PATCH = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "exec.write", limit: 120, windowMs: 60_000 } }, async (req, { params }) => {
  const { id } = await params;
  const body = await parseBody(req, patchSchema);
  const updated = await getRepos().executions.update(id, {
    status: body.status,
    steps: body.steps?.map((s) => ({ ...s, txHash: s.txHash as Hash | undefined })),
    updatedAt: Date.now(),
  });
  if (!updated) throw new AppError("NOT_FOUND", "Execution not found", 404);
  return json({ execution: updated });
});

export const GET = route<{ params: Promise<{ id: string }> }>({}, async (_req, { params }) => {
  const { id } = await params;
  const exec = await getRepos().executions.get(id);
  if (!exec) throw new AppError("NOT_FOUND", "Execution not found", 404);
  return json({ execution: exec });
});
