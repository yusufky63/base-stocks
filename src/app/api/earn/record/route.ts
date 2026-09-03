import { z } from "zod";
import type { Hash } from "viem";
import { route, json, parseBody, addressSchema, hashSchema } from "@/lib/api";
import { getRepos, type EarnActionRecord } from "@/db/repositories";

const createSchema = z.object({
  id: z.string().min(8).max(64),
  owner: addressSchema,
  opportunityId: z.string().min(3).max(120),
  provider: z.string().max(32),
  action: z.enum(["deposit", "withdraw"]),
  amount: z.string().regex(/^\d+$/),
  usdValue: z.number().nullable(),
  txHash: hashSchema.optional(),
});

/**
 * App-side Earn records (activity source). Like trade records these are NOT proof of execution;
 * the activity service verifies them against the transaction receipt.
 */
export const POST = route({ rateLimit: { key: "earn.record", limit: 60, windowMs: 60_000 } }, async (req) => {
  const body = await parseBody(req, createSchema);
  const record: EarnActionRecord = { ...body, txHash: body.txHash as Hash | undefined, createdAt: Date.now() };
  await getRepos().earnActions.create(record);
  return json({ action: record }, { status: 201 });
});
