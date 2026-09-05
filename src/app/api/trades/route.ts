import { z } from "zod";
import { route, json, parseBody, parseQuery, addressSchema, hashSchema } from "@/lib/api";
import { getRepos, type TradeRecord } from "@/db/repositories";
import type { Hash } from "viem";
import { invalidatePortfolioSnapshot } from "@/services/portfolio-service";

const createSchema = z.object({
  id: z.string().min(8).max(64),
  owner: addressSchema,
  side: z.enum(["buy", "sell"]),
  assetAddress: addressSchema,
  sellAmount: z.string().regex(/^\d+$/),
  buyAmount: z.string().regex(/^\d+$/),
  usdValue: z.number().nullable(),
  provider: z.string().max(32),
  txHash: hashSchema.optional(),
  recipient: addressSchema.optional(),
  /** "confirmed" only when the caller already holds the receipt (a batch leg); otherwise submitted. */
  status: z.enum(["submitted", "confirmed"]).optional(),
});

/**
 * App-side trade records (activity source #1). These are NOT proof of execution; the activity
 * service and the platform statistics verify them against the transaction receipt.
 */
export const POST = route({ rateLimit: { key: "trades.write", limit: 60, windowMs: 60_000, durable: true } }, async (req) => {
  const body = await parseBody(req, createSchema);
  const record: TradeRecord = { ...body, txHash: body.txHash as Hash | undefined, status: body.txHash && body.status === "confirmed" ? "confirmed" : "submitted", createdAt: Date.now() };
  await getRepos().trades.create(record);
  invalidatePortfolioSnapshot(body.owner);
  return json({ trade: record }, { status: 201 });
});

export const GET = route({ rateLimit: { key: "trades.read", limit: 120, windowMs: 60_000 } }, async (req) => {
  const { owner } = parseQuery(req, z.object({ owner: addressSchema }));
  return json({ trades: await getRepos().trades.listByOwner(owner) });
});
