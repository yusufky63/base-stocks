import type { B20Asset } from "@/domain/asset";
import { cached } from "@/lib/cache";
import { classifyFreshness, isUsMarketOpen, secondsSinceUsMarketClose, secondsSinceUsMarketOpen, type ReferenceFreshness } from "@/lib/market-hours";
import { getYahooQuote, type EquityQuote } from "@/providers/market-data/equity/yahoo";

/**
 * The reference for a stock with no Chainlink feed: its share price on the US market, times the
 * token's multiplier, which is how Base defines a tokenized stock's price. It stands where the
 * Chainlink reference stands for the other stocks (the headline-price gate, the trade panel's gap,
 * the firm-quote guard) so a pool far from the stock is caught for these too. It is an off-chain,
 * delayed number: no contract reads it, and the public API does not republish it.
 */
export interface EquityReference {
  /** Per ONE raw token: share price times multiplier, like a Chainlink total-return answer. */
  priceUsd: number;
  sharePriceUsd: number;
  /** Unix ms of the share price. */
  updatedAt: number;
  freshness: Exclude<ReferenceFreshness, "frozen">;
  /** Hourly token prices over the last week, oldest first (unix seconds), for sparklines. */
  points: Array<{ time: number; price: number }>;
  source: "yahoo";
}

/** A share price older than this during a session is no longer the market's. */
const LIVE_MAX_AGE_S = 30 * 60;
const QUOTE_CACHE = { ttlMs: 10 * 60_000, staleMs: 50 * 60_000, shared: true, isPartial: (v: unknown) => v === null, partialTtlMs: 2 * 60_000 } as const;
const CONCURRENCY = 4;

/** Stocks that need one: issued, active and without a Chainlink feed. */
export function needsEquityReference(asset: B20Asset): boolean {
  return !asset.oracle && asset.status === "active" && asset.totalSupply > 0n && (asset.underlying ?? "").trim().length > 0;
}

export function toEquityReference(asset: Pick<B20Asset, "multiplier" | "wadPrecision">, quote: EquityQuote, now = Date.now()): EquityReference | null {
  const multiplier = Number(asset.multiplier) / Number(asset.wadPrecision);
  if (!Number.isFinite(multiplier) || !(multiplier > 0)) return null;
  const at = new Date(now);
  const freshness = classifyFreshness({
    ageSeconds: Math.max(0, (now - quote.updatedAt) / 1000),
    thresholdSeconds: LIVE_MAX_AGE_S,
    paused: false,
    marketOpen: isUsMarketOpen(at),
    sinceCloseSeconds: secondsSinceUsMarketClose(at),
    sinceOpenSeconds: secondsSinceUsMarketOpen(at),
  });
  return {
    priceUsd: quote.priceUsd * multiplier,
    sharePriceUsd: quote.priceUsd,
    updatedAt: quote.updatedAt,
    freshness: freshness === "frozen" ? "stale" : freshness,
    points: quote.points.map((p) => ({ time: p.time, price: p.price * multiplier })),
    source: "yahoo",
  };
}

/**
 * References for the stocks among `assets` that need one, keyed by canonical id. Each share price
 * is cached on its own for ten minutes and shared across instances, so a page asking for one stock
 * and a page asking for all of them make the same few calls. A stock Yahoo cannot answer for is
 * simply absent.
 */
export async function getEquityReferences(assets: B20Asset[]): Promise<Map<string, EquityReference>> {
  const wanted = assets.filter(needsEquityReference);
  const out = new Map<string, EquityReference>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, async () => {
      for (;;) {
        const asset = wanted[next++];
        if (!asset) return;
        const quote = await cached(`equity:quote:v1:${asset.underlying.toUpperCase()}`, QUOTE_CACHE, () => getYahooQuote(asset.underlying)).catch(() => null);
        const ref = quote ? toEquityReference(asset, quote) : null;
        if (ref) out.set(asset.canonicalId, ref);
      }
    }),
  );
  return out;
}
