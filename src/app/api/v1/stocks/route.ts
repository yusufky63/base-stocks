import { getAssets } from "@/services/b20-asset-service";
import { getPriceViews } from "@/services/price-service";
import { toV1Stock } from "@/lib/api-v1/shape";
import { v1Json, v1Options } from "@/lib/api-v1/respond";

export const maxDuration = 60;

/**
 * Every listed tokenized stock with its price, reference and market depth.
 *
 * Free and uncredentialed. Thirty seconds of CDN cache means the origin computes this at most
 * twice a minute per region however many callers there are, so the endpoint costs the same
 * whether one person reads it or a thousand agents do.
 */
export async function GET(): Promise<Response> {
  const assets = await getAssets();
  const views = await getPriceViews(assets).catch(() => new Map());
  const stocks = assets.map((a) => toV1Stock(a, views.get(a.canonicalId)));
  return v1Json({ count: stocks.length, stocks }, { cacheSeconds: 30, staleSeconds: 300 });
}

export const OPTIONS = v1Options;
