import { describe, expect, it } from "vitest";

/**
 * The adaptive `eth_getLogs` split, checked against the behaviour that broke the hourly
 * maintenance run: a public fallback RPC that caps the block range far below our chunk.
 *
 * The implementation lives in chain-index-service (module-private); this mirrors its contract so
 * the arithmetic — full coverage, no overlap, no infinite descent — cannot regress silently.
 */
const MIN_CHUNK = 1_000n;

function isRangeLimit(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /limited to|block range|range is too large|exceed|too many blocks|up to \d+ blocks/i.test(m);
}

async function getLogsAdaptive<T>(from: bigint, to: bigint, read: (a: bigint, b: bigint) => Promise<T[]>): Promise<T[]> {
  try {
    return await read(from, to);
  } catch (err) {
    const span = to - from + 1n;
    if (!isRangeLimit(err) || span <= MIN_CHUNK) throw err;
    const mid = from + span / 2n - 1n;
    const [a, b] = [await getLogsAdaptive(from, mid, read), await getLogsAdaptive(mid + 1n, to, read)];
    return [...a, ...b];
  }
}

/** A reader that refuses ranges wider than `cap`, like the public RPCs do. */
function cappedReader(cap: bigint) {
  const calls: Array<[bigint, bigint]> = [];
  const read = async (a: bigint, b: bigint) => {
    if (b - a + 1n > cap) throw new Error(`eth_getLogs is limited to 0 - ${cap} blocks range`);
    calls.push([a, b]);
    return [Number(a)];
  };
  return { calls, read };
}

describe("adaptive getLogs range", () => {
  it("covers the whole range exactly once when the RPC caps below our chunk", async () => {
    const { calls, read } = cappedReader(2_000n);
    await getLogsAdaptive(1_000n, 10_999n, read);
    const sorted = [...calls].sort((x, y) => Number(x[0] - y[0]));
    expect(sorted[0]![0]).toBe(1_000n);
    expect(sorted[sorted.length - 1]![1]).toBe(10_999n);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]![0]).toBe(sorted[i - 1]![1] + 1n);
    expect(calls.every(([a, b]) => b - a + 1n <= 2_000n)).toBe(true);
  });

  it("gives up rather than descending forever when the cap is below the floor", async () => {
    const { calls, read } = cappedReader(50n);
    await expect(getLogsAdaptive(1_000n, 10_999n, read)).rejects.toThrow(/limited to/);
    // It stopped at the floor instead of splitting into hundreds of calls.
    expect(calls.length).toBe(0);
  });

  it("re-throws anything that is not a range complaint", async () => {
    const read = async () => {
      throw new Error("execution reverted");
    };
    await expect(getLogsAdaptive(1n, 100_000n, read)).rejects.toThrow(/execution reverted/);
  });

  it("makes one call when the RPC accepts the whole range", async () => {
    const { calls, read } = cappedReader(100_000n);
    await getLogsAdaptive(1_000n, 10_999n, read);
    expect(calls).toEqual([[1_000n, 10_999n]]);
  });
});
