import { z } from "zod";
import { route, json, parseBody, parseQuery, addressSchema, hashSchema } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import type { PortfolioExecution } from "@/domain/portfolio";
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

const createSchema = z.object({
  id: z.string().min(8).max(64),
  owner: addressSchema,
  totalUsd: z.number().positive(),
  steps: z.array(stepSchema).min(1).max(20),
});

/** Persist a multi-leg execution so partial fills are never lost (spec §25). */
export const POST = route({ rateLimit: { key: "exec.write", limit: 30, windowMs: 60_000 } }, async (req) => {
  const body = await parseBody(req, createSchema);
  const now = Date.now();
  const exec: PortfolioExecution = {
    id: body.id,
    owner: body.owner,
    status: "READY",
    totalUsd: body.totalUsd,
    steps: body.steps.map((s) => ({ ...s, txHash: s.txHash as Hash | undefined })),
    createdAt: now,
    updatedAt: now,
  };
  await getRepos().executions.create(exec);
  return json({ execution: exec }, { status: 201 });
});

export const GET = route({ rateLimit: { key: "exec.read", limit: 120, windowMs: 60_000 } }, async (req) => {
  const { owner } = parseQuery(req, z.object({ owner: addressSchema }));
  return json({ executions: await getRepos().executions.listByOwner(owner) });
});

export { stepSchema };
