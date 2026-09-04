import type { B20Asset } from "@/domain/asset";
import { readRoundHistory } from "@/providers/market-data/chainlink/history";
import { cached } from "@/lib/cache";
import { metrics } from "@/lib/http";

const D1_S = 24 * 3600;
const D7_S = 7 * 24 * 3600;
const POINTS = 32;

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

/**
 * Reference-price sparklines for every asset from Chainlink round history, in two windows from a
 * single history read: `d1` (24 hours, to sit beside the 24h change) and `d7` (7 days, for the
 * markets table's labelled "7d" column). One cached computation serves all visitors; 15-minute TTL.
 */
export async function getSparklines(assets: B20Asset[]): Promise<{ d1: Record<string, number[]>; d7: Record<string, number[]> }> {
  return cached("sparklines:1d7d:v1", { ttlMs: 15 * 60_000, staleMs: 60 * 60_000 }, async () => {
    const now = Math.floor(Date.now() / 1000);
    const d1: Record<string, number[]> = {};
    const d7: Record<string, number[]> = {};
    await Promise.all(
      assets.map(async (a) => {
        if (!a.oracle) return;
        try {
          const rounds = await readRoundHistory(a.oracle.feed, 400);
          if (rounds.length === 0) return;
          d1[a.canonicalId] = bucketSeries(rounds, now - D1_S, D1_S);
          d7[a.canonicalId] = bucketSeries(rounds, now - D7_S, D7_S);
        } catch (err) {
          metrics.count("sparklines", false, err instanceof Error ? err.message : String(err));
        }
      }),
    );
    return { d1, d7 };
  });
}
