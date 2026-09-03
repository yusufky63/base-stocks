import { route, json, addressParam } from "@/lib/api";
import { getAsset, enrichLogos } from "@/services/b20-asset-service";
import { getPriceViews } from "@/services/price-service";
import { toAssetDTO } from "@/domain/asset";
import { AppError } from "@/lib/errors";

export const GET = route<{ params: Promise<{ address: string }> }>({ rateLimit: { key: "asset", limit: 240, windowMs: 60_000 } }, async (_req, { params }) => {
  const address = await addressParam(params);
  const asset = await getAsset(address);
  if (!asset) throw new AppError("NOT_FOUND", "This asset is not a verified Coinbase Tokenized Stock.", 404);
  const [views] = await Promise.all([getPriceViews([asset]), enrichLogos([asset])]);
  return json({ asset: toAssetDTO(asset), price: views.get(asset.canonicalId) ?? null }, { cacheSeconds: 10, staleSeconds: 60 });
});
