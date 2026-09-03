import { describe, expect, it } from "vitest";
import { roundsToCandles } from "./history";
import { isStale } from "./reader";

describe("chainlink staleness", () => {
  it("flags feeds older than the threshold", () => {
    const now = 1_000_000;
    expect(isStale(BigInt(now - 10), 3600, now)).toBe(false);
    expect(isStale(BigInt(now - 3601), 3600, now)).toBe(true);
  });
});

describe("roundsToCandles", () => {
  it("buckets sparse rounds and carries the last price forward", () => {
    const now = 100_000;
    const points = [
      { time: now - 90_000, price: 95 },
      { time: now - 3600 * 5, price: 100 },
      { time: now - 3600 * 2 - 10, price: 110 },
      { time: now - 3600 * 2 + 600, price: 105 },
    ];
    const candles = roundsToCandles(points, "1D", now);
    expect(candles.length).toBeGreaterThan(200);
    // strictly increasing, contiguous 5-minute buckets
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.time - candles[i - 1]!.time).toBe(300);
    const last = candles[candles.length - 1]!;
    expect(last.close).toBe(105);
    const withMoves = candles.filter((c) => c.high !== c.low);
    expect(withMoves.length).toBeGreaterThan(0);
  });

  it("returns empty when there is no data", () => {
    expect(roundsToCandles([], "1W")).toEqual([]);
  });
});
