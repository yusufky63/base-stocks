import { getAssets } from "@/services/b20-asset-service";
import { getPriceViews } from "@/services/price-service";
import { getPoolMap } from "@/services/pool-map-service";
import { findStock, toV1Stock } from "@/lib/api-v1/shape";
import { v1Error, v1Json, v1Options } from "@/lib/api-v1/respond";

export const maxDuration = 60;

/** One stock by ticker ("NVDA"), token symbol ("NVDAc") or contract address, with its pools. */
export async function GET(_req: Request, { params }: { params: Promise<{ symbol: string }> }): Promise<Response> {
  const { symbol } = await params;
  const assets = await getAssets();
  const asset = findStock(assets, symbol);
  if (!asset) {
    return v1Error(404, "UNKNOWN_STOCK", `No listed stock matches "${symbol.slice(0, 12)}".`, `Try one of: ${assets.map((a) => a.underlying).join(", ")}`);
  }
  const [views, pools] = await Promise.all([getPriceViews([asset]).catch(() => new Map()), getPoolMap(asset.address).catch(() => null)]);
  return v1Json(
    {
      stock: toV1Stock(asset, views.get(asset.canonicalId)),
      pools:
        pools?.pools.slice(0, 10).map((p) => ({
          address: p.address,
          name: p.name,
          dex: p.dexLabel,
          liquidityUsd: p.reserveUsd,
          volume24hUsd: p.volume24hUsd,
          /** The pool the app reads prices and charts from. */
          isPrimary: p.primary,
          url: p.url,
        })) ?? [],
    },
    { cacheSeconds: 30, staleSeconds: 300 },
  );
}

export const OPTIONS = v1Options;
