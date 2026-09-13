import { z } from "zod";
import type { Address } from "viem";
import { route, json, addressParam, parseQuery } from "@/lib/api";
import { getAsset } from "@/services/b20-asset-service";
import { getChartSeries, type ChartSubject } from "@/services/market-service";
import { findCuratedAsset } from "@/lib/b20/registry";
import { TIMEFRAMES, type Timeframe } from "@/domain/market";
import { AppError } from "@/lib/errors";

/** Serverless budget: upstream providers and the model may take longer than the 10 s default. */
export const maxDuration = 60;

const querySchema = z.object({ timeframe: z.enum(TIMEFRAMES as [Timeframe, ...Timeframe[]]).default("1M") });

export const GET = route<{ params: Promise<{ address: string }> }>({ rateLimit: { key: "ohlcv", limit: 120, windowMs: 60_000 } }, async (req, { params }) => {
  const address = await addressParam(params);
  const { timeframe } = parseQuery(req, querySchema);
  // A chart needs the token and its feed. The curated list knows both without touching the chain;
  // only a discovered stock pays for the full asset read.
  const curated = findCuratedAsset(address);
  let subject: ChartSubject;
  if (curated) subject = { address: curated.address as Address, feed: curated.chainlinkFeed as Address };
  else {
    const asset = await getAsset(address);
    if (!asset) throw new AppError("NOT_FOUND", "Unknown asset", 404);
    subject = { address: asset.address, feed: asset.oracle?.feed ?? null };
  }
  const series = await getChartSeries(subject, timeframe);
  return json(series, { cacheSeconds: 60, staleSeconds: 300 });
});
