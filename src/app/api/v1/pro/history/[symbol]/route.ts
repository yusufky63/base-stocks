import type { NextRequest } from "next/server";
import { getAssets } from "@/services/b20-asset-service";
import { getChartSeries } from "@/services/market-service";
import { TIMEFRAMES, type Timeframe } from "@/domain/market";
import { findStock } from "@/lib/api-v1/shape";
import { v1Error, v1Json, v1Options } from "@/lib/api-v1/respond";
import { withPayment } from "@/lib/api-v1/x402";

export const maxDuration = 60;

/**
 * A stock's full candle history at any supported timeframe, labelled with where each series came
 * from — the DEX pool, or the Chainlink feed when no pool priced that window.
 *
 * Priced because it is the heavy read: every call reaches an upstream chart provider for a
 * specific token and window, which no shared cache can collapse the way a single current price
 * can. The current price stays free at `/api/v1/stocks/{symbol}`.
 *
 * The symbol is read from the path rather than the route context: `withX402` invokes the handler
 * with the request alone and drops Next's `{ params }`, so reading it there would be undefined
 * the moment payment is switched on.
 */
async function handler(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const symbol = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
  const tf = (url.searchParams.get("timeframe") ?? "1M") as Timeframe;
  if (!TIMEFRAMES.includes(tf)) return v1Error(400, "BAD_TIMEFRAME", `timeframe must be one of ${TIMEFRAMES.join(", ")}. Nothing was charged.`);

  const assets = await getAssets();
  const asset = findStock(assets, symbol);
  if (!asset) return v1Error(404, "UNKNOWN_STOCK", `No listed stock matches "${symbol.slice(0, 12)}". Nothing was charged.`);

  const series = await getChartSeries(asset, tf);
  return v1Json(
    {
      symbol: asset.underlying,
      address: asset.address,
      timeframe: series.timeframe,
      /** "market" = the DEX pool's own candles. "reference" = built from the Chainlink feed. */
      source: series.source,
      /**
       * Chainlink's equity feeds report total-return values, so a reference series is already
       * multiplier-adjusted and comparable across a split. A market series is the pool's price.
       */
      multiplier: asset.multiplier.toString(),
      count: series.candles.length,
      candles: series.candles,
    },
    { cacheSeconds: 300, staleSeconds: 1_800 },
  );
}

export const GET = await withPayment(handler, "BaseStocks price history: full candle series for one tokenized stock");
export const OPTIONS = v1Options;
