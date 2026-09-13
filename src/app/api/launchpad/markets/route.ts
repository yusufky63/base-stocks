import { route, json } from "@/lib/api";
import { LAUNCHPAD_URL } from "@/content/ecosystem";

/**
 * Tokens launched on StockPair against one of our stocks, proxied server-side so the browser
 * never depends on the launchpad's CORS policy. The launchpad being down or empty is not an
 * error here: the stock page simply hides the module.
 */
type LaunchpadMarket = {
  token: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  priceUsd: number | null;
  fdvUsd: number | null;
  change24hPercent: number | null;
  volume24hUsd: number | null;
  holders: number;
  launchedAt: string;
};

/**
 * The launchpad's list can carry the same token twice (one row per pool) and tokens nobody holds
 * (a launch that never filled). Neither belongs on a stock page: one row per token, holders only.
 */
export function tidyMarkets(markets: LaunchpadMarket[]): LaunchpadMarket[] {
  const seen = new Set<string>();
  const out: LaunchpadMarket[] = [];
  for (const m of markets) {
    const key = (m.token ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(key) || seen.has(key)) continue;
    if (!(Number(m.holders) > 0)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

export const GET = route({ rateLimit: { key: "launchpad-markets", limit: 60, windowMs: 60_000 } }, async (req) => {
  const stock = new URL(req.url).searchParams.get("stock") ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(stock)) return json({ markets: [] }, { cacheSeconds: 300 });
  try {
    const res = await fetch(`${LAUNCHPAD_URL}/api/markets?stock=${stock}&limit=12`, { signal: AbortSignal.timeout(5_000), next: { revalidate: 60 } });
    if (!res.ok) return json({ markets: [] }, { cacheSeconds: 60 });
    const body = (await res.json()) as { markets?: LaunchpadMarket[] };
    const markets = tidyMarkets(
      (body.markets ?? []).map((m) => ({
        token: m.token,
        name: m.name,
        symbol: m.symbol,
        imageUrl: m.imageUrl ?? null,
        priceUsd: m.priceUsd ?? null,
        fdvUsd: m.fdvUsd ?? null,
        change24hPercent: m.change24hPercent ?? null,
        volume24hUsd: m.volume24hUsd ?? null,
        holders: m.holders ?? 0,
        launchedAt: m.launchedAt,
      })),
    ).slice(0, 6);
    return json({ markets }, { cacheSeconds: 60, staleSeconds: 600 });
  } catch {
    return json({ markets: [] }, { cacheSeconds: 60 });
  }
});
