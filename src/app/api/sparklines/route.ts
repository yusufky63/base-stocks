import { after } from "next/server";
import { route, json } from "@/lib/api";
import { getAssets } from "@/services/b20-asset-service";
import { getSparklines, refreshDexSparklines } from "@/services/sparkline-service";

export const maxDuration = 60;

/**
 * Sparklines for all assets (shared cache): `series` is 7-day, `series24h` is 24-hour. Chainlink
 * rounds where the stock has a feed, the pool's hourly candles where it does not.
 */
export const GET = route({ rateLimit: { key: "sparklines", limit: 120, windowMs: 60_000 } }, async () => {
  const assets = await getAssets();
  // Serverless has no timers: the pool series are topped up after the response, a few stocks per call.
  after(() => refreshDexSparklines(assets).catch(() => 0));
  const { d1, d7 } = await getSparklines(assets);
  return json({ series: d7, series24h: d1, updatedAt: Date.now() }, { cacheSeconds: 300, staleSeconds: 900 });
});
