import { route, json } from "@/lib/api";
import { getAssets } from "@/services/b20-asset-service";
import { getSparklines } from "@/services/sparkline-service";

/** Reference sparklines for all assets (shared cache): `series` is 7-day, `series24h` is 24-hour. */
export const GET = route({ rateLimit: { key: "sparklines", limit: 120, windowMs: 60_000 } }, async () => {
  const assets = await getAssets();
  const { d1, d7 } = await getSparklines(assets);
  return json({ series: d7, series24h: d1, updatedAt: Date.now() }, { cacheSeconds: 300, staleSeconds: 900 });
});
