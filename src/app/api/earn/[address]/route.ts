import { z } from "zod";
import { route, json, addressParam, parseQuery, addressSchema } from "@/lib/api";
import { discoverEarn } from "@/services/earn-opportunity-service";

/** Runtime Earn discovery. Never blocks the stock page; hidden when nothing is available. */
export const GET = route<{ params: Promise<{ address: string }> }>({ rateLimit: { key: "earn", limit: 120, windowMs: 60_000 } }, async (req, { params }) => {
  const address = await addressParam(params);
  const { user } = parseQuery(req, z.object({ user: addressSchema.optional() }));
  const result = await discoverEarn(address, user);
  return json(result, { cacheSeconds: 60, staleSeconds: 300 });
});
