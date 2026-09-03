import { toAssetDTO } from "@/domain/asset";
import { getAssets, getAsset, enrichLogos } from "@/services/b20-asset-service";
import { getPriceViews, getEthUsd } from "@/services/price-service";
import { getRepos } from "@/db/repositories";
import type { AssetsResponse, AssetResponse } from "@/lib/client-api";
import type { PortfolioTemplate } from "@/domain/portfolio";

/**
 * Server-side prefetch helpers used by pages so the first useful content is rendered
 * without a client round-trip. Every helper is tolerant: failures return null and the
 * client hooks take over.
 */
export async function loadAssetsResponse(): Promise<AssetsResponse | null> {
  try {
    const assets = await getAssets();
    const [views, ethUsd] = await Promise.all([getPriceViews(assets), getEthUsd().catch(() => null), enrichLogos(assets)]);
    return { assets: assets.map(toAssetDTO), prices: Object.fromEntries(views), ethUsd, readAt: Date.now() };
  } catch (err) {
    console.error("[server-data] assets", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function loadAssetResponse(address: string): Promise<AssetResponse | null> {
  try {
    const asset = await getAsset(address);
    if (!asset) return null;
    const [views] = await Promise.all([getPriceViews([asset]), enrichLogos([asset])]);
    return { asset: toAssetDTO(asset), price: views.get(asset.canonicalId) ?? null };
  } catch (err) {
    console.error("[server-data] asset", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function loadTemplates(): Promise<PortfolioTemplate[]> {
  try {
    return await getRepos().templates.list(true);
  } catch (err) {
    console.error("[server-data] templates", err instanceof Error ? err.message : err);
    return [];
  }
}
