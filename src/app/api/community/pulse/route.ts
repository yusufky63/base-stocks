import { route, json } from "@/lib/api";
import { getCommunityPulse } from "@/services/community-service";

/** Anonymous community aggregates (7d): most bought / sold, active traders, top baskets. */
export const GET = route({ rateLimit: { key: "community.pulse", limit: 120, windowMs: 60_000 } }, async () => {
  return json(await getCommunityPulse(), { cacheSeconds: 60, staleSeconds: 600 });
});
