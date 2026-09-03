import { z } from "zod";
import { route, json, addressParam, parseQuery } from "@/lib/api";
import { getAsset } from "@/services/b20-asset-service";
import { getChartSeries } from "@/services/market-service";
import { TIMEFRAMES, type Timeframe } from "@/domain/market";
import { AppError } from "@/lib/errors";

/** Serverless budget: upstream providers and the model may take longer than the 10 s default. */
export const maxDuration = 60;

const querySchema = z.object({ timeframe: z.enum(TIMEFRAMES as [Timeframe, ...Timeframe[]]).default("1M") });

export const GET = route<{ params: Promise<{ address: string }> }>({ rateLimit: { key: "ohlcv", limit: 120, windowMs: 60_000 } }, async (req, { params }) => {
  const address = await addressParam(params);
  const { timeframe } = parseQuery(req, querySchema);
  const asset = await getAsset(address);
  if (!asset) throw new AppError("NOT_FOUND", "Unknown asset", 404);
  const series = await getChartSeries(asset, timeframe);
  return json(series, { cacheSeconds: 60, staleSeconds: 300 });
});
