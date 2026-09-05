import type { Address } from "viem";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { aggregatorV3Abi } from "@/lib/chainlink/abi";
import type { Candle, Timeframe } from "@/domain/market";
import { cached } from "@/lib/cache";
import { metrics } from "@/lib/http";

export interface RoundPoint {
  /** Unix seconds. */
  time: number;
  price: number;
}

const BATCH = 120;

/**
 * Reference-only historical reconstruction from Chainlink round history (spec §10 fallback).
 * Walks backwards from the latest round within the current phase. Stops at the first
 * missing round (phase boundary) or when `maxRounds` is reached.
 * Prices are total-return token prices (multiplier already applied by the feed).
 */
export async function readRoundHistory(feed: Address, maxRounds = 900): Promise<RoundPoint[]> {
  return cached(`chainlink:history:${feed.toLowerCase()}:${maxRounds}`, { ttlMs: 5 * 60_000, staleMs: 30 * 60_000, shared: true }, async () => {
    const client = getServerPublicClient();
    const [latest, decimals] = await Promise.all([
      client.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "latestRoundData" }),
      client.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "decimals" }),
    ]);
    const scale = 10 ** Number(decimals);
    const points: RoundPoint[] = [{ time: Number(latest[3]), price: Number(latest[1]) / scale }];
    let roundId = latest[0];
    let fetched = 0;
    let stop = false;
    while (!stop && fetched < maxRounds) {
      const ids: bigint[] = [];
      for (let i = 0; i < BATCH && fetched + i < maxRounds; i++) {
        const id = roundId - BigInt(i + 1);
        if (id <= 0n) break;
        ids.push(id);
      }
      if (ids.length === 0) break;
      const res = await client.multicall({
        contracts: ids.map((id) => ({ address: feed, abi: aggregatorV3Abi, functionName: "getRoundData" as const, args: [id] as const })),
        allowFailure: true,
      });
      for (const r of res) {
        if (r.status !== "success") {
          stop = true;
          break;
        }
        const [, answer, , updatedAt] = r.result as readonly [bigint, bigint, bigint, bigint, bigint];
        if (updatedAt === 0n || answer <= 0n) {
          stop = true;
          break;
        }
        points.push({ time: Number(updatedAt), price: Number(answer) / scale });
      }
      fetched += ids.length;
      roundId -= BigInt(ids.length);
    }
    metrics.count("chainlink.history", true);
    points.sort((a, b) => a.time - b.time);
    return points;
  });
}

const WINDOW_SECONDS: Record<Timeframe, number> = {
  "1D": 24 * 3600,
  "1W": 7 * 24 * 3600,
  "1M": 30 * 24 * 3600,
  "3M": 90 * 24 * 3600,
  "1Y": 365 * 24 * 3600,
};
const BUCKET_SECONDS: Record<Timeframe, number> = {
  "1D": 5 * 60,
  "1W": 3600,
  "1M": 4 * 3600,
  "3M": 24 * 3600,
  "1Y": 24 * 3600,
};

/** Bucket sparse oracle updates into candles; empty buckets carry the last price forward. */
export function roundsToCandles(points: RoundPoint[], timeframe: Timeframe, nowSeconds = Math.floor(Date.now() / 1000)): Candle[] {
  if (points.length === 0) return [];
  const bucket = BUCKET_SECONDS[timeframe];
  const start = nowSeconds - WINDOW_SECONDS[timeframe];
  const sorted = [...points].sort((a, b) => a.time - b.time);
  // last known price before the window start
  let last = sorted.find((p) => p.time <= start)?.price;
  for (const p of sorted) if (p.time <= start) last = p.price;
  const inWindow = sorted.filter((p) => p.time > start);
  if (last === undefined && inWindow.length === 0) return [];

  const candles: Candle[] = [];
  const firstBucket = Math.floor(((inWindow[0]?.time ?? start) - 1) / bucket) * bucket;
  const beginBucket = last !== undefined ? Math.floor(start / bucket) * bucket : firstBucket;
  let idx = 0;
  let prevClose = last ?? inWindow[0]!.price;
  for (let t = beginBucket; t <= nowSeconds; t += bucket) {
    const end = t + bucket;
    let open = prevClose;
    let high = prevClose;
    let low = prevClose;
    let close = prevClose;
    let touched = false;
    while (idx < inWindow.length && inWindow[idx]!.time < end) {
      const p = inWindow[idx]!.price;
      if (!touched) {
        open = prevClose;
        touched = true;
      }
      high = Math.max(high, p);
      low = Math.min(low, p);
      close = p;
      idx++;
    }
    candles.push({ time: t, open, high, low, close, volume: 0 });
    prevClose = close;
  }
  return candles;
}
