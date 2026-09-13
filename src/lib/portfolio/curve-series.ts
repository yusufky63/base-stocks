/**
 * Bucketing a sparse price history onto a fixed grid, for the portfolio value curve.
 *
 * Pure, and separate from the reading because the one rule it enforces is easy to get wrong:
 * **a bucket before the oldest round known is null, not the oldest price.** Carrying the first
 * round backwards drew a flat line across the part of the window the feed never covered, which
 * read as "the stock did not move for three weeks" when the truth was "we have three days of
 * history". Inside the coverage the last price is carried forward across gaps, which is what a
 * feed that updates on a heartbeat means.
 */
export interface PricePoint {
  /** Unix seconds. */
  time: number;
  price: number;
}

export interface BucketedSeries {
  /** One entry per bucket, in order; null where no round had been published by the bucket's end. */
  values: Array<number | null>;
  /** Unix seconds of the oldest round, i.e. where the series starts meaning something. */
  coverageFrom: number;
  /** Index of the first bucket with a value, or -1 when none has one. */
  firstIndex: number;
}

/**
 * `points` buckets of `bucket` seconds from `startS`, each valued at the last round published at
 * or before the bucket's end. Rounds need not be sorted.
 */
export function bucketSeries(rounds: readonly PricePoint[], startS: number, bucket: number, points: number): BucketedSeries | null {
  if (rounds.length === 0 || points <= 0 || bucket <= 0) return null;
  const sorted = [...rounds].sort((a, b) => a.time - b.time);
  const coverageFrom = sorted[0]!.time;
  let last: number | null = null;
  let idx = 0;
  // The last price before the window opens, if the history reaches that far back.
  while (idx < sorted.length && sorted[idx]!.time <= startS) {
    last = sorted[idx]!.price;
    idx += 1;
  }
  const values: Array<number | null> = [];
  let firstIndex = -1;
  for (let i = 0; i < points; i++) {
    const end = startS + (i + 1) * bucket;
    while (idx < sorted.length && sorted[idx]!.time <= end) {
      last = sorted[idx]!.price;
      idx += 1;
    }
    if (last !== null && firstIndex === -1) firstIndex = i;
    values.push(last);
  }
  return { values, coverageFrom, firstIndex };
}

/**
 * Equal-weight index of several bucketed series: each member normalised to 1 at the first bucket
 * every member covers, then averaged. Buckets before that are null, so a member with a short
 * history shortens the index rather than being dropped from it or faked flat. A member with a
 * zero or negative price anywhere is garbage and is left out; a feed does not publish zero.
 */
export function equalWeightIndex(series: readonly (readonly (number | null)[])[], points: number): { points: Array<number | null>; members: number; firstIndex: number } | null {
  const usable = series.filter((s) => s.length === points && s.every((v) => v === null || v > 0) && s.some((v) => v !== null));
  if (usable.length === 0) return null;
  let start = -1;
  for (let i = 0; i < points && start === -1; i++) if (usable.every((s) => s[i] !== null)) start = i;
  if (start === -1) return null;
  const out: Array<number | null> = new Array<number | null>(points).fill(null);
  for (let i = start; i < points; i++) {
    let sum = 0;
    let n = 0;
    for (const s of usable) {
      const v = s[i];
      if (v === null) continue;
      sum += v / s[start]!;
      n += 1;
    }
    out[i] = n > 0 ? sum / n : null;
  }
  return { points: out, members: usable.length, firstIndex: start };
}
