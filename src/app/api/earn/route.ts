import { route, json } from "@/lib/api";
import { invalidate } from "@/lib/cache";
import { getAssets } from "@/services/b20-asset-service";
import { discoverEarn, rankStockVenues } from "@/services/earn-opportunity-service";

/** Serverless budget: upstream providers and the model may take longer than the 10 s default. */
export const maxDuration = 60;

/** Earn overview: runtime discovery across all verified assets (parallel, cached per asset). */
export const GET = route({ rateLimit: { key: "earn.all", limit: 30, windowMs: 60_000 } }, async (req) => {
  // Manual refresh: a provider hiccup gets cached with the snapshot for TTL.earn, so the refresh
  // button busts the discovery caches and re-scans instead of re-serving the same partial list.
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  if (fresh) await invalidate("earn:");
  const assets = await getAssets();
  const results = await Promise.all(assets.map((a) => discoverEarn(a.address).catch(() => null)));
  const found = results.flatMap((r, i) => (r ? r.opportunities.map((o) => ({ ...o, symbol: assets[i]!.symbol, underlying: assets[i]!.underlying, logoURI: assets[i]!.logoURI })) : []));
  // Graded by what the stock is paired against, then by depth, with the unjoinable dust removed.
  const items = rankStockVenues(found, new Set(assets.map((a) => a.address.toLowerCase())));
  // Honest empty states: say what was scanned and which venue did not answer.
  const unavailable = new Set<string>();
  let scanned = 0;
  for (const r of results) {
    if (!r) continue;
    scanned += 1;
    for (const p of r.unavailableProviders) unavailable.add(p);
  }
  const checked = { assets: scanned, of: assets.length, providers: ["morpho", "aave", "compound", "aerodrome", "uniswap", "geckoterminal-pools"], unavailable: [...unavailable] };
  // A run missing a provider is served, but only briefly: the CDN holding it for a minute would
  // undo the short server-side retry window behind it.
  const partial = unavailable.size > 0;
  const cache = fresh ? { cacheSeconds: 0 } : partial ? { cacheSeconds: 15, staleSeconds: 0 } : { cacheSeconds: 60, staleSeconds: 300 };
  return json({ items, checked, updatedAt: Date.now() }, cache);
});
