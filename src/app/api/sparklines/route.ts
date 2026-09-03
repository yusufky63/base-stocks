import { route, json } from "@/lib/api";
import { getAssets } from "@/services/b20-asset-service";
import { getSparklines } from "@/services/sparkline-service";

/** 7-day reference sparklines for all assets (shared cache). */
export const GET = route({ rateLimit: { key: "sparklines", limit: 120, windowMs: 60_000 } }, async () => {
  const assets = await getAssets();
  const series = await getSparklines(assets);
  return json({ series, updatedAt: Date.now() }, { cacheSeconds: 300, staleSeconds: 900 });
});
