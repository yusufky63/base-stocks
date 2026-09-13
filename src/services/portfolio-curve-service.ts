import type { Address } from "viem";
import type { B20Asset } from "@/domain/asset";
import { getAssets } from "@/services/b20-asset-service";
import { getPortfolioSnapshot } from "@/services/portfolio-service";
import { readRoundHistory } from "@/providers/market-data/chainlink/history";
import { bucketSeries, equalWeightIndex, type BucketedSeries } from "@/lib/portfolio/curve-series";
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
 *
 * Coverage is finite: one history read walks back `MAX_ROUNDS` rounds, which on a feed that
 * updates a few times a day reaches back weeks, not a year. The curve starts where the shortest
 * history among the holdings starts and says so (`coverageFrom`), rather than drawing a flat line
 * over the part of the window nobody has prices for.
 */
export type CurveWindow = "1D" | "1W" | "1M" | "3M" | "1Y";

interface WindowSpec {
  seconds: number;
  points: number;
}

const WINDOWS: Record<CurveWindow, WindowSpec> = {
  "1D": { seconds: 24 * 3600, points: 48 },
  "1W": { seconds: 7 * 24 * 3600, points: 56 },
  "1M": { seconds: 30 * 24 * 3600, points: 60 },
  "3M": { seconds: 90 * 24 * 3600, points: 60 },
  "1Y": { seconds: 365 * 24 * 3600, points: 60 },
};

/**
 * One history per feed, whatever the window: the 1D chart used to read 120 rounds, the 1W 400
 * and the 1M 900, each under its own cache key, so one feed cost three reads and three entries
 * for what is one list. The longest read covers every window; the shorter ones are slices of it.
 */
const MAX_ROUNDS = 900;

export interface CurvePoint {
  /** Unix ms at the end of the bucket. */
  t: number;
  usd: number;
}

export interface PortfolioCurve {
  window: CurveWindow;
  /** Only the buckets every priced holding has history for; may be shorter than the window. */
  points: CurvePoint[];
  /** Value now, and at the first point that carries one. */
  latestUsd: number | null;
  firstUsd: number | null;
  changePct: number | null;
  /** Stocks with no reference feed to price back; excluded from every point, not zeroed. */
  missing: string[];
  /** True when the whole window is flat because no feed updated — a weekend, typically. */
  flat: boolean;
  /** The equal-weight index of every issued stock over the same window, scaled to start where the portfolio starts. */
  benchmark: BenchmarkCurve | null;
  /**
   * Unix ms where the reference history of the shortest-covered holding begins. When it is later
   * than the window's start the curve is shorter than asked for, and the page should say so.
   */
  coverageFrom: number | null;
  /** Unix ms the window was asked to start at. */
  windowFrom: number;
  readAt: number;
}

export interface BenchmarkCurve {
  name: string;
  /** Same buckets as `points`; USD-scaled so the two lines share a scale. */
  points: number[];
  changePct: number | null;
  /** How many issued stocks had a feed with history for the window. */
  members: number;
}

/** Reference price per raw token at each bucket edge; null before the feed's history begins. Cached per feed and window. */
async function seriesFor(asset: B20Asset, spec: WindowSpec, startS: number, bucket: number): Promise<BucketedSeries | null> {
  if (!asset.oracle) return null;
  const key = `curve:${asset.oracle.feed}:${spec.seconds}:${spec.points}`;
  return cached(key, { ttlMs: 5 * 60_000, staleMs: 30 * 60_000, shared: true }, async () => {
    try {
      const rounds = await readRoundHistory(asset.oracle!.feed, MAX_ROUNDS);
      return bucketSeries(rounds, startS, bucket, spec.points);
    } catch (err) {
      metrics.count("portfolio.curve", false, err instanceof Error ? err.message : String(err));
      return null;
    }
  });
}

export { equalWeightIndex };

export interface BenchmarkIndex {
  /** Normalised to 1 at `firstIndex`; null before it. */
  points: Array<number | null>;
  members: number;
  firstIndex: number;
}

/**
 * The benchmark: every *issued* stock with a reference feed, equal-weighted, each normalised to 1
 * at the first bucket all of them cover. A listed stock the issuer has not minted yet has a feed
 * and no holders; putting it in the index compared a portfolio to nine stocks nobody could own.
 *
 * One shared-cached series per window for the whole platform — a thousand portfolio pages read
 * the same feed histories once — and each wallet scales it to its own starting value at request
 * time, which is arithmetic, not RPC.
 */
export async function getBenchmarkIndex(window: CurveWindow): Promise<BenchmarkIndex | null> {
  const spec = WINDOWS[window];
  return cached(`curve:index:${window}`, { ttlMs: 5 * 60_000, staleMs: 30 * 60_000, shared: true }, async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const startS = nowS - spec.seconds;
    const bucket = spec.seconds / spec.points;
    const assets = (await getAssets()).filter((a) => a.oracle && a.totalSupply > 0n);
    const series = (await Promise.all(assets.map((a) => seriesFor(a, spec, startS, bucket)))).filter((s): s is BucketedSeries => !!s).map((s) => s.values);
    return equalWeightIndex(series, spec.points);
  });
}

export async function getPortfolioCurve(owner: Address, window: CurveWindow): Promise<PortfolioCurve> {
  const spec = WINDOWS[window];
  const nowS = Math.floor(Date.now() / 1000);
  const startS = nowS - spec.seconds;
  const bucket = spec.seconds / spec.points;

  const [snapshot, assets, index] = await Promise.all([getPortfolioSnapshot(owner), getAssets(), getBenchmarkIndex(window).catch(() => null)]);
  const held = snapshot.holdings.filter((h) => BigInt(h.rawBalance) > 0n);

  const totals = new Array<number>(spec.points).fill(0);
  const missing: string[] = [];
  let contributors = 0;
  // The curve starts at the first bucket every priced holding covers; before that, the total is
  // unknown rather than understated, and the page is told where coverage begins.
  let firstIndex = 0;
  let coverageFromS: number | null = null;

  await Promise.all(
    held.map(async (h) => {
      const asset = assets.find((a) => a.canonicalId === h.assetAddress.toLowerCase());
      if (!asset) return;
      const series = await seriesFor(asset, spec, startS, bucket);
      if (!series || series.firstIndex === -1) {
        // No feed, or no history at all: leaving the stock out understates the line, but inventing
        // a flat price for it would be worse, and the response names what was left out.
        missing.push(h.underlying);
        return;
      }
      contributors += 1;
      firstIndex = Math.max(firstIndex, series.firstIndex);
      coverageFromS = coverageFromS === null ? series.coverageFrom : Math.max(coverageFromS, series.coverageFrom);
      const units = Number(BigInt(h.rawBalance)) / 10 ** h.decimals;
      for (let i = 0; i < spec.points; i++) totals[i]! += units * (series.values[i] ?? 0);
    }),
  );

  const points: CurvePoint[] = contributors === 0 ? [] : totals.slice(firstIndex).map((usd, i) => ({ t: (startS + (firstIndex + i + 1) * bucket) * 1000, usd }));
  const firstUsd = points[0]?.usd ?? null;
  const latestUsd = points[points.length - 1]?.usd ?? null;
  const flat = points.length > 1 && points.every((p) => Math.abs(p.usd - points[0]!.usd) < 1e-9);

  // The index is rescaled to the portfolio's own first point, over the same buckets. A bucket the
  // index has no value for (its own coverage starts later) makes the comparison impossible.
  let benchmark: BenchmarkCurve | null = null;
  if (index && firstUsd !== null && firstUsd > 0 && points.length > 0) {
    const base = index.points[firstIndex];
    const slice = index.points.slice(firstIndex);
    if (base !== null && base !== undefined && base > 0 && slice.every((v) => v !== null)) {
      const scaled = slice.map((v) => (v! / base) * firstUsd);
      benchmark = { name: `Equal-weight ${index.members} issued`, points: scaled, changePct: (slice[slice.length - 1]! / base - 1) * 100, members: index.members };
    }
  }

  return {
    window,
    points,
    latestUsd,
    firstUsd,
    changePct: firstUsd !== null && latestUsd !== null && firstUsd > 0 ? ((latestUsd - firstUsd) / firstUsd) * 100 : null,
    missing,
    flat,
    benchmark,
    coverageFrom: contributors === 0 ? null : Math.max((coverageFromS ?? startS) * 1000, startS * 1000),
    windowFrom: startS * 1000,
    readAt: Date.now(),
  };
}
