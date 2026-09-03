import type { B20Asset } from "@/domain/asset";
import { readRoundHistory } from "@/providers/market-data/chainlink/history";
import { cached } from "@/lib/cache";
import { metrics } from "@/lib/http";

const WINDOW_S = 7 * 24 * 3600;
const POINTS = 32;

/**
 * 7-day sparklines for every asset from Chainlink round history (reference prices).
 * One cached computation serves all visitors; refreshed every 15 minutes.
 */
export async function getSparklines(assets: B20Asset[]): Promise<Record<string, number[]>> {
  return cached("sparklines:7d", { ttlMs: 15 * 60_000, staleMs: 60 * 60_000 }, async () => {
    const now = Math.floor(Date.now() / 1000);
    const start = now - WINDOW_S;
    const bucket = WINDOW_S / POINTS;
    const out: Record<string, number[]> = {};
    await Promise.all(
      assets.map(async (a) => {
        if (!a.oracle) return;
        try {
          const rounds = await readRoundHistory(a.oracle.feed, 400);
          if (rounds.length === 0) return;
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
          out[a.canonicalId] = series;
        } catch (err) {
          metrics.count("sparklines", false, err instanceof Error ? err.message : String(err));
        }
      }),
    );
    return out;
  });
}
