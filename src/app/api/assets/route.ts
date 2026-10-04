import { getAssetCatalog } from "@/services/stock-catalog-service";
import { after } from "next/server";
import { route, json } from "@/lib/api";
import { maybeScanInBackground, enrichLogos } from "@/services/b20-asset-service";
import { getPriceViews, getEthUsd } from "@/services/price-service";
import { toAssetDTO } from "@/domain/asset";

export const maxDuration = 60;

/**
 * Every verified B20 asset with live state + price views (market/reference kept separate). `listed`
 * marks the ones with supply, DEX liquidity and two-way routes; the rest stay in the response
 * because holdings, baskets, gifts and orders are looked up in it by address.
 */
export const GET = route({ rateLimit: { key: "assets", limit: 120, windowMs: 60_000 } }, async () => {
  // Serverless has no timers: piggyback a light discovery scan on traffic, at most every 30 min.
  after(() => maybeScanInBackground());
  const { assets, listed } = await getAssetCatalog();
  const [views, ethUsd] = await Promise.all([getPriceViews(assets), getEthUsd().catch(() => null), enrichLogos(assets)]);
  return json(
    {
      assets: assets.map((a) => ({ ...toAssetDTO(a), listed: listed.has(a.canonicalId) })),
      prices: Object.fromEntries(views),
      ethUsd,
      readAt: Date.now(),
    },
    { cacheSeconds: 10, staleSeconds: 60 },
  );
});
