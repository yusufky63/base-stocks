import { route, json } from "@/lib/api";
import { discoverUsdcEarn } from "@/services/earn-opportunity-service";

/** USDC yield venues discovered at runtime (Morpho vaults, Aave reserve). */
export const GET = route({ rateLimit: { key: "earn.usdc", limit: 120, windowMs: 60_000 } }, async () => {
  return json(await discoverUsdcEarn(), { cacheSeconds: 60, staleSeconds: 600 });
});
