import { route, json } from "@/lib/api";
import { digestsEnabled, getMarketDigest } from "@/services/digest-service";

/** Serverless budget: upstream providers and the model may take longer than the 10 s default. */
export const maxDuration = 60;

/** Shared AI market brief for the current 6-hour slot (same text for everyone; at most 4 model calls a day). */
export const GET = route({ rateLimit: { key: "news.digest", limit: 120, windowMs: 60_000 } }, async () => {
  if (!digestsEnabled()) return json({ enabled: false, digest: null }, { cacheSeconds: 300, staleSeconds: 1800 });
  const digest = await getMarketDigest();
  return json({ enabled: true, digest }, { cacheSeconds: 300, staleSeconds: 1800 });
});
