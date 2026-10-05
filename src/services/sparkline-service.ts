import type { B20Asset } from "@/domain/asset";
import type { Candle } from "@/domain/market";
import { readRoundHistory } from "@/providers/market-data/chainlink/history";
import { cached, invalidate } from "@/lib/cache";
import { metrics } from "@/lib/http";
import { recallGood } from "@/lib/last-good";
import { chartCandlesKey, getChartSeries } from "./market-service";
import { getEquityReferences, type EquityReference } from "./equity-reference-service";

const D1_S = 24 * 3600;
const D7_S = 7 * 24 * 3600;
const POINTS = 32;
const SPARKLINES_KEY = "sparklines:1d7d:v3";

/** A remembered DEX series older than this is not drawn: a week's shape that ends half a day ago misleads. */
const DEX_SERIES_MAX_AGE_MS = 12 * 3600_000;
/** A DEX series younger than this is left alone by the refresher. */
const DEX_SERIES_REFRESH_MS = 30 * 60_000;

/** Bucket an ascending round history into POINTS samples over [now - windowS, now], carrying the last known price forward. */
function bucketSeries(rounds: { time: number; price: number }[], start: number, windowS: number): number[] {
  const bucket = windowS / POINTS;
  const series: number[] = [];
  let idx = 0;
  let last = rounds[0]!.price;
  for (const p of rounds) if (p.time <= start) last = p.price;
  for (let i = 0; i < POINTS; i++) {
    const end = start + (i + 1) * bucket;
    while (idx < rounds.length && rounds[idx]!.time <= end) {
      if (rounds[idx]!.time > start) last = rounds[idx]!.price;
      idx++;
    }
    series.push(last);
  }
  return series;
}

/** Stocks whose sparkline has to come from the pool because there is no feed to read rounds from. */
function needsDexSeries(asset: B20Asset): boolean {
  return !asset.oracle && asset.status === "active" && asset.totalSupply > 0n;
}

/**
 * Sparklines for every asset, in two windows from a single history read: `d1` (24 hours, to sit
 * beside the 24h change) and `d7` (7 days, for the markets table's labelled "7d" column). One
 * cached computation serves all visitors; 15-minute TTL.
 *
 * A stock with a feed is drawn from Chainlink round history. A stock without one is drawn from its
 * share price's hourly closes (times the multiplier), the same reference that stands in for the
 * feed on the price, so every line in the table shows the stock rather than one pool. Failing
 * that it falls back to its pool's hourly candles, the series the 1W chart already fetches and
 * remembers. That series is only read here, never fetched: the candle provider allows about thirty
 * calls a minute, and thirty stocks asking at once would spend the whole budget inside one
 * request. `refreshDexSparklines` keeps the remembered series current a few stocks at a time.
 */
export async function getSparklines(assets: B20Asset[]): Promise<{ d1: Record<string, number[]>; d7: Record<string, number[]> }> {
  return cached(SPARKLINES_KEY, { ttlMs: 15 * 60_000, staleMs: 60 * 60_000, shared: true }, async () => {
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000);
    const d1: Record<string, number[]> = {};
    const d7: Record<string, number[]> = {};
    const put = (asset: B20Asset, points: { time: number; price: number }[]) => {
      d1[asset.canonicalId] = bucketSeries(points, now - D1_S, D1_S);
      d7[asset.canonicalId] = bucketSeries(points, now - D7_S, D7_S);
    };
    const equity = await getEquityReferences(assets).catch(() => new Map<string, EquityReference>());
    await Promise.all(
      assets.map(async (a) => {
        try {
          if (a.oracle) {
            const rounds = await readRoundHistory(a.oracle.feed, 400);
            if (rounds.length > 0) put(a, rounds);
            return;
          }
          const share = equity.get(a.canonicalId);
          if (share && share.points.length >= 2) {
            put(a, share.points);
            return;
          }
          if (!needsDexSeries(a)) return;
          const good = await recallGood<Candle[]>(chartCandlesKey(a.address, "1W"));
          if (!good || good.value.length < 2 || nowMs - good.at > DEX_SERIES_MAX_AGE_MS) return;
          put(a, good.value.map((c) => ({ time: c.time, price: c.close })));
        } catch (err) {
          metrics.count("sparklines", false, err instanceof Error ? err.message : String(err));
        }
      }),
    );
    return { d1, d7 };
  });
}

let refreshing = false;

/**
 * Fetch the hourly pool series for the stocks without a feed whose remembered one is missing or
 * oldest, `limit` per call, one after another. Meant to run after a response has been sent; a
 * second call while one is running does nothing. Returns how many series were refreshed.
 */
export async function refreshDexSparklines(assets: B20Asset[], limit = 6): Promise<number> {
  if (refreshing) return 0;
  refreshing = true;
  try {
    const now = Date.now();
    const ages = await Promise.all(
      assets.filter(needsDexSeries).map(async (asset) => {
        const good = await recallGood<Candle[]>(chartCandlesKey(asset.address, "1W")).catch(() => null);
        return { asset, at: good?.at ?? 0 };
      }),
    );
    const due = ages.filter((x) => now - x.at > DEX_SERIES_REFRESH_MS).sort((a, b) => a.at - b.at).slice(0, limit);
    let refreshed = 0;
    for (const { asset } of due) {
      // getChartSeries remembers a series it could fetch; a failure leaves the older one in place.
      const series = await getChartSeries({ address: asset.address, feed: null }, "1W").catch(() => null);
      if (series?.source === "market" && series.candles.length > 1) refreshed += 1;
    }
    // Let the next reader see the new series instead of waiting out the window.
    if (refreshed > 0) await invalidate(SPARKLINES_KEY);
    return refreshed;
  } finally {
    refreshing = false;
  }
}
