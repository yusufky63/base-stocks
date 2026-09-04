import type { Address } from "viem";
import type { B20Asset } from "@/domain/asset";
import { getAssets } from "@/services/b20-asset-service";
import { getPortfolioSnapshot } from "@/services/portfolio-service";
import { readRoundHistory } from "@/providers/market-data/chainlink/history";
import { cached } from "@/lib/cache";
import { metrics } from "@/lib/http";

/**
 * A value curve for the stocks a wallet holds right now, priced back through time with the
 * Chainlink reference.
 *
 * What this is, precisely, because the difference matters: it is *today's* holdings valued at
 * yesterday's prices, not a replay of the account. It answers "how has what I hold moved", which
 * is the question a chart on a portfolio page is actually asked. It is not a record of the
 * account's worth over time — buying more, selling, or being gifted stock all change that, and
 * none of it appears here. The daily snapshots are that record, and they stay separate.
 *
 * The reference feed rather than the DEX price on purpose: Chainlink has history a client can read
 * back for a year, and on the thin markets a fresh listing has, the pool price is noise. Stock
 * feeds are 24/5 and update on a heartbeat or a deviation, so a weekend curve is honestly flat.
 */
export type CurveWindow = "1D" | "1W" | "1M" | "3M" | "1Y";

interface WindowSpec {
  seconds: number;
  points: number;
  /** How many Chainlink rounds to read back; each feed updates a few times a day at most. */
  rounds: number;
}

const WINDOWS: Record<CurveWindow, WindowSpec> = {
  "1D": { seconds: 24 * 3600, points: 48, rounds: 120 },
  "1W": { seconds: 7 * 24 * 3600, points: 56, rounds: 400 },
  "1M": { seconds: 30 * 24 * 3600, points: 60, rounds: 900 },
  "3M": { seconds: 90 * 24 * 3600, points: 60, rounds: 900 },
  "1Y": { seconds: 365 * 24 * 3600, points: 60, rounds: 900 },
};

export interface CurvePoint {
  /** Unix ms at the end of the bucket. */
  t: number;
  usd: number;
}

export interface PortfolioCurve {
  window: CurveWindow;
  points: CurvePoint[];
  /** Value now, and at the first point that carries one. */
  latestUsd: number | null;
  firstUsd: number | null;
  changePct: number | null;
  /** Stocks with no reference feed to price back; excluded from every point, not zeroed. */
  missing: string[];
  /** True when the whole window is flat because no feed updated — a weekend, typically. */
  flat: boolean;
  readAt: number;
}

/**
 * Reference price per raw token at each bucket edge, carried forward across gaps. Cached per feed
 * and window so one visitor's chart warms every other's.
 */
async function seriesFor(asset: B20Asset, spec: WindowSpec, startS: number, bucket: number): Promise<number[] | null> {
  if (!asset.oracle) return null;
  const key = `curve:${asset.oracle.feed}:${spec.seconds}:${spec.points}`;
  return cached(key, { ttlMs: 5 * 60_000, staleMs: 30 * 60_000 }, async () => {
    try {
      const rounds = await readRoundHistory(asset.oracle!.feed, spec.rounds);
      if (rounds.length === 0) return null;
      // Start from the last price known before the window opens, so the line does not begin at zero.
      let last = rounds[0]!.price;
      for (const p of rounds) if (p.time <= startS) last = p.price;
      const series: number[] = [];
      let idx = 0;
      for (let i = 0; i < spec.points; i++) {
        const end = startS + (i + 1) * bucket;
        while (idx < rounds.length && rounds[idx]!.time <= end) {
          last = rounds[idx]!.price;
          idx += 1;
        }
        series.push(last);
      }
      return series;
    } catch (err) {
      metrics.count("portfolio.curve", false, err instanceof Error ? err.message : String(err));
      return null;
    }
  });
}

export async function getPortfolioCurve(owner: Address, window: CurveWindow): Promise<PortfolioCurve> {
  const spec = WINDOWS[window];
  const nowS = Math.floor(Date.now() / 1000);
  const startS = nowS - spec.seconds;
  const bucket = spec.seconds / spec.points;

  const [snapshot, assets] = await Promise.all([getPortfolioSnapshot(owner), getAssets()]);
  const held = snapshot.holdings.filter((h) => BigInt(h.rawBalance) > 0n);

  const totals = new Array<number>(spec.points).fill(0);
  const missing: string[] = [];
  let contributors = 0;

  await Promise.all(
    held.map(async (h) => {
      const asset = assets.find((a) => a.canonicalId === h.assetAddress.toLowerCase());
      if (!asset) return;
      const series = await seriesFor(asset, spec, startS, bucket);
      if (!series) {
        // No feed: leaving the stock out understates the line, but inventing a flat price for it
        // would be worse, and the response names what was left out.
        missing.push(h.underlying);
        return;
      }
      contributors += 1;
      const units = Number(BigInt(h.rawBalance)) / 10 ** h.decimals;
      for (let i = 0; i < spec.points; i++) totals[i]! += units * series[i]!;
    }),
  );

  const points: CurvePoint[] = contributors === 0 ? [] : totals.map((usd, i) => ({ t: (startS + (i + 1) * bucket) * 1000, usd }));
  const firstUsd = points[0]?.usd ?? null;
  const latestUsd = points[points.length - 1]?.usd ?? null;
  const flat = points.length > 1 && points.every((p) => Math.abs(p.usd - points[0]!.usd) < 1e-9);

  return {
    window,
    points,
    latestUsd,
    firstUsd,
    changePct: firstUsd !== null && latestUsd !== null && firstUsd > 0 ? ((latestUsd - firstUsd) / firstUsd) * 100 : null,
    missing,
    flat,
    readAt: Date.now(),
  };
}
