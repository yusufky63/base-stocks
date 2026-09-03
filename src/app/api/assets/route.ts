import { after } from "next/server";
import { route, json } from "@/lib/api";
import { maybeScanInBackground, getAssets, enrichLogos } from "@/services/b20-asset-service";
import { getPriceViews, getEthUsd } from "@/services/price-service";
import { toAssetDTO } from "@/domain/asset";

/** All verified B20 assets with live state + price views (market/reference kept separate). */
export const GET = route({ rateLimit: { key: "assets", limit: 120, windowMs: 60_000 } }, async () => {
  // Serverless has no timers: piggyback a light discovery scan on traffic, at most every 30 min.
  after(() => maybeScanInBackground());
  const assets = await getAssets();
  const [views, ethUsd] = await Promise.all([getPriceViews(assets), getEthUsd().catch(() => null), enrichLogos(assets)]);
  return json(
    {
      assets: assets.map(toAssetDTO),
      prices: Object.fromEntries(views),
      ethUsd,
      readAt: Date.now(),
    },
    { cacheSeconds: 10, staleSeconds: 60 },
  );
});
