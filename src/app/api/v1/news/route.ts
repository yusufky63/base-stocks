import { getAssets } from "@/services/b20-asset-service";
import { getEcosystemNews, getMarketWideNews, getNews } from "@/services/news-service";
import { findStock } from "@/lib/api-v1/shape";
import { v1Error, v1Json, v1Options } from "@/lib/api-v1/respond";

export const maxDuration = 60;

/**
 * Headlines: a stock's own wire (`?symbol=NVDA`), the market desks (`?scope=market`), or the
 * Base and Coinbase feed that follows tokenized-stock listings (`?scope=ecosystem`, the default).
 * Titles and links only — the app does not republish article text.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const scope = (url.searchParams.get("scope") ?? "ecosystem").toLowerCase();
  const symbol = url.searchParams.get("symbol");
  const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit")) || 10));

  const assets = await getAssets();
  let items;
  if (symbol) {
    const asset = findStock(assets, symbol);
    if (!asset) return v1Error(404, "UNKNOWN_STOCK", `No listed stock matches "${symbol.slice(0, 12)}".`);
    items = await getNews(asset.underlying, asset.name, limit);
  } else if (scope === "market") {
    items = await getMarketWideNews(limit);
  } else if (scope === "ecosystem") {
    items = await getEcosystemNews(limit, assets.map((a) => a.underlying));
  } else {
    return v1Error(400, "BAD_SCOPE", `scope must be "ecosystem" or "market", or pass ?symbol=`);
  }

  return v1Json(
    {
      scope: symbol ? "stock" : scope,
      symbol: symbol ? findStock(assets, symbol)?.underlying : undefined,
      count: items.length,
      items: items.slice(0, limit).map((n) => ({ title: n.title, url: n.url, source: n.source, publishedAt: n.publishedAt, symbol: n.ticker, mentions: n.tickers ?? [] })),
    },
    { cacheSeconds: 300, staleSeconds: 3_600 },
  );
}

export const OPTIONS = v1Options;
