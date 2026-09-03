import { route, json, addressParam } from "@/lib/api";
import { getPoolMap } from "@/services/pool-map-service";

/** Every DEX pool for the stock as GeckoTerminal sees it, with what this app does with each. */
export const GET = route<{ params: Promise<{ address: string }> }>({ rateLimit: { key: "market.pools", limit: 120, windowMs: 60_000 } }, async (_req, { params }) => {
  const address = await addressParam(params);
  return json(await getPoolMap(address), { cacheSeconds: 120, staleSeconds: 600 });
});
