import { z } from "zod";
import { route, json, parseBody, addressSchema } from "@/lib/api";
import { getAssets } from "@/services/b20-asset-service";
import { buildPlan, quotePlan, validateAllocations } from "@/services/portfolio-service";
import type { Allocation } from "@/domain/portfolio";

/** Serverless budget: upstream providers and the model may take longer than the 10 s default. */
export const maxDuration = 60;

const allocationSchema = z.object({
  assetAddress: z.union([z.literal("USDC"), addressSchema]),
  weightBps: z.number().int().min(1).max(10_000),
});

const bodySchema = z.object({
  allocations: z.array(allocationSchema).min(1).max(20),
  totalUsd: z.number().positive().max(10_000_000),
  taker: addressSchema.optional(),
  quote: z.boolean().default(true),
  source: z.enum(["template", "custom", "ai"]).default("custom"),
  /** What to do with money for stocks that are not issued yet. */
  deferredPolicy: z.enum(["reserve", "redistribute"]).default("reserve"),
});

/** Server-side allocation validation + per-leg indicative quotes. */
export const POST = route({ rateLimit: { key: "portfolio.plan", limit: 30, windowMs: 60_000 } }, async (req) => {
  const body = await parseBody(req, bodySchema);
  const validation = validateAllocations(body.allocations as Allocation[]);
  if (!validation.ok) return json({ ok: false, errors: validation.errors }, { status: 400 });
  const assets = await getAssets();
  const plan = buildPlan({ allocations: validation.normalized, source: body.source }, body.totalUsd, assets, { deferredPolicy: body.deferredPolicy });
  const result = body.quote ? await quotePlan(plan, body.taker) : plan;
  return json({ ok: true, plan: result });
});
