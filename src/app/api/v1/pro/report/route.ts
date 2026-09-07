import { getMarketDigest } from "@/services/digest-service";
import { getAssets } from "@/services/b20-asset-service";
import { getPriceViews } from "@/services/price-service";
import { toV1Stock } from "@/lib/api-v1/shape";
import { v1Error, v1Json, v1Options } from "@/lib/api-v1/respond";
import { withPayment } from "@/lib/api-v1/x402";

export const maxDuration = 60;

/**
 * The written market brief plus the prices it was written against — one object a caller can act
 * on without stitching two endpoints together.
 *
 * Priced because it is the one read backed by a model: the brief costs tokens to produce, and the
 * daily budget it draws on is shared by everyone. The free `/api/v1/stocks` carries the same
 * numbers; what is paid for here is the reading of them.
 */
async function handler(): Promise<Response> {
  const [digest, assets] = await Promise.all([getMarketDigest().catch(() => null), getAssets()]);
  if (!digest) return v1Error(503, "REPORT_UNAVAILABLE", "No market brief is available right now. Nothing was charged.");
  const views = await getPriceViews(assets).catch(() => new Map());
  return v1Json(
    {
      report: {
        headline: digest.headline,
        summary: digest.summary,
        mood: digest.mood,
        marketOpen: digest.marketOpen,
        perStock: digest.bullets,
        ecosystem: digest.spotlight,
        themes: digest.themes,
        headlinesRead: digest.headlines,
        generatedAt: digest.generatedAt,
        model: digest.model,
      },
      stocks: assets.map((a) => toV1Stock(a, views.get(a.canonicalId))),
      disclaimer: "Written from public headlines and live prices. Not investment advice, and no prediction of future prices.",
    },
    // The brief itself only changes every six hours; a caller who pays twice inside that window
    // would get the same words, so the answer is cached and the second call is free.
    { cacheSeconds: 900, staleSeconds: 3_600 },
  );
}

export const GET = await withPayment(handler, "BaseStocks market report: the shared AI brief with the live prices behind it");
export const OPTIONS = v1Options;
