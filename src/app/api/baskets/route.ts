import { z } from "zod";
import { route, json, parseBody, parseQuery, addressSchema } from "@/lib/api";
import { requireSession } from "@/lib/auth/session";
import { listBaskets, publishBasket } from "@/services/community-service";
import type { Allocation } from "@/domain/portfolio";

const allocationSchema = z.object({ assetAddress: z.union([z.literal("USDC"), addressSchema]), weightBps: z.number().int().min(1).max(10_000) });

const createSchema = z.object({
  name: z.string().min(3).max(48),
  description: z.string().max(280).optional(),
  allocations: z.array(allocationSchema).min(1).max(20),
});

export const GET = route({ rateLimit: { key: "baskets.read", limit: 120, windowMs: 60_000 } }, async (req) => {
  const { sort, limit } = parseQuery(req, z.object({ sort: z.enum(["votes", "new"]).default("votes"), limit: z.coerce.number().int().min(1).max(50).default(30) }));
  return json({ baskets: await listBaskets(sort, limit) }, { cacheSeconds: 30, staleSeconds: 300 });
});

/** Publish a community basket (requires sign-in). Public by design for now. */
export const POST = route({ rateLimit: { key: "baskets.write", limit: 10, windowMs: 60_000, durable: true } }, async (req) => {
  const owner = requireSession(req);
  const body = await parseBody(req, createSchema);
  const basket = await publishBasket(owner, { name: body.name, description: body.description, allocations: body.allocations as Allocation[] });
  return json({ basket }, { status: 201 });
});
