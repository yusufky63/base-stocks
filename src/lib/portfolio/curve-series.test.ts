import { describe, expect, it } from "vitest";
import { bucketSeries, equalWeightIndex } from "./curve-series";

const START = 1_000_000;
const BUCKET = 100;

describe("bucketSeries", () => {
  it("values each bucket at the last round published by its end and carries prices across gaps", () => {
    const rounds = [
      { time: START - 50, price: 10 }, // before the window: the opening price
      { time: START + 150, price: 12 }, // lands in bucket 1
      { time: START + 420, price: 9 }, // lands in bucket 4
    ];
    const s = bucketSeries(rounds, START, BUCKET, 6)!;
    expect(s.values).toEqual([10, 12, 12, 12, 9, 9]);
    expect(s.firstIndex).toBe(0);
    expect(s.coverageFrom).toBe(START - 50);
  });

  it("emits null before the oldest round instead of carrying it backwards", () => {
    const rounds = [
      { time: START + 250, price: 20 },
      { time: START + 330, price: 21 },
    ];
    const s = bucketSeries(rounds, START, BUCKET, 5)!;
    expect(s.values).toEqual([null, null, 20, 21, 21]);
    expect(s.firstIndex).toBe(2);
    expect(s.coverageFrom).toBe(START + 250);
  });

  it("takes the last round at or before the bucket edge, whatever order the rounds arrive in", () => {
    const rounds = [
      { time: START + 200, price: 3 }, // exactly on bucket 1's end: belongs to bucket 1
      { time: START + 100, price: 2 }, // exactly on bucket 0's end: belongs to bucket 0
      { time: START + 10, price: 1 },
    ];
    const s = bucketSeries(rounds, START, BUCKET, 3)!;
    expect(s.values).toEqual([2, 3, 3]);
  });

  it("has nothing to say without rounds or buckets", () => {
    expect(bucketSeries([], START, BUCKET, 5)).toBeNull();
    expect(bucketSeries([{ time: START, price: 1 }], START, BUCKET, 0)).toBeNull();
  });
});

describe("equalWeightIndex", () => {
  it("normalises each member to 1 at the first bucket all members cover", () => {
    const a = [100, 110, 121];
    const b = [10, 10, 9];
    const idx = equalWeightIndex([a, b], 3)!;
    expect(idx.members).toBe(2);
    expect(idx.firstIndex).toBe(0);
    expect(idx.points[0]).toBeCloseTo(1);
    expect(idx.points[1]).toBeCloseTo((1.1 + 1) / 2);
    expect(idx.points[2]).toBeCloseTo((1.21 + 0.9) / 2);
  });

  it("starts where the shortest history starts rather than dropping or faking that member", () => {
    const long = [50, 50, 60, 60];
    const short = [null, null, 30, 33];
    const idx = equalWeightIndex([long, short], 4)!;
    expect(idx.members).toBe(2);
    expect(idx.firstIndex).toBe(2);
    expect(idx.points).toEqual([null, null, 1, expect.closeTo((1 + 1.1) / 2, 9)]);
  });

  it("ignores a member with no history at all or a zero price, and gives up when nothing overlaps", () => {
    expect(equalWeightIndex([[1, 2, 3], [null, null, null]], 3)!.members).toBe(1);
    expect(equalWeightIndex([[1, 2, 3], [0, 2, 3]], 3)!.members).toBe(1);
    expect(equalWeightIndex([[1, null, null], [null, null, 2]], 3)).toBeNull();
    expect(equalWeightIndex([], 3)).toBeNull();
  });
});
