import { z } from "zod";
import { route, json, parseQuery } from "@/lib/api";
import { getAssets } from "@/services/b20-asset-service";
import { getEcosystemNews, getMarketNews, getMarketWideNews, getNews, getXPosts } from "@/services/news-service";
import { AppError } from "@/lib/errors";

const querySchema = z.object({
  ticker: z.string().regex(/^[A-Za-z.]{1,8}$/).optional(),
  scope: z.enum(["stocks", "markets", "ecosystem", "x"]).default("stocks"),
  limit: z.coerce.number().int().min(1).max(30).default(8),
});

const shortName = (name: string) => name.replace(/\b(Corporation|Inc\.?|Corp\.?|Group|Platforms|Holdings)\b/g, "").trim();

/**
 * Short headlines, shared cache.
 *   ?ticker=NVDA        → per-stock feed (Google News, Yahoo Finance, Nasdaq, Seeking Alpha)
 *   ?scope=markets      → market-wide business headlines (CNBC, MarketWatch, WSJ, Investing.com)
 *   ?scope=ecosystem    → tokenized stocks on Base and Coinbase's listings, tagged with the tickers named
 *   ?scope=x            → posts by @base, @coinbase, @CoinbaseAssets and @CoinbaseMarkets (public embed feed)
 *   default             → mixed feed across the 13 stocks
 */
export const GET = route({ rateLimit: { key: "news", limit: 120, windowMs: 60_000 } }, async (req) => {
  const { ticker, scope, limit } = parseQuery(req, querySchema);
  if (scope === "markets") {
    const items = await getMarketWideNews(limit);
    return json({ items, updatedAt: Date.now() }, { cacheSeconds: 300, staleSeconds: 1800 });
  }
  const assets = await getAssets();
  if (scope === "ecosystem") {
    const items = await getEcosystemNews(limit, assets.map((a) => a.underlying));
    return json({ items, updatedAt: Date.now() }, { cacheSeconds: 300, staleSeconds: 1800 });
  }
  if (scope === "x") {
    const items = await getXPosts(limit, assets.map((a) => a.underlying));
    return json({ items, updatedAt: Date.now() }, { cacheSeconds: 300, staleSeconds: 1800 });
  }
  if (ticker) {
    const asset = assets.find((a) => a.underlying.toLowerCase() === ticker.toLowerCase());
    if (!asset) throw new AppError("NOT_FOUND", "Unknown ticker", 404);
    const items = await getNews(asset.underlying, shortName(asset.name), limit);
    return json({ items, updatedAt: Date.now() }, { cacheSeconds: 300, staleSeconds: 1800 });
  }
  const items = await getMarketNews(assets.map((a) => ({ ticker: a.underlying, name: shortName(a.name) })), 2, limit);
  return json({ items, updatedAt: Date.now() }, { cacheSeconds: 300, staleSeconds: 1800 });
});
