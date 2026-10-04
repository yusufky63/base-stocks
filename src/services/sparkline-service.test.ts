import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { B20Asset } from "@/domain/asset";
import type { Candle } from "@/domain/market";

const h = vi.hoisted(() => ({ rounds: vi.fn(), series: vi.fn() }));
vi.mock("@/providers/market-data/chainlink/history", () => ({ readRoundHistory: h.rounds }));
vi.mock("@/lib/shared-store", () => ({ getSharedStore: () => null }));
vi.mock("./market-service", () => ({
  chartCandlesKey: (address: string, timeframe: string) => `ohlcv:${address.toLowerCase()}:${timeframe}`,
  getChartSeries: h.series,
}));

import { invalidate } from "@/lib/cache";
import { rememberGood, resetLastGoodMemory } from "@/lib/last-good";
import { getSparklines, refreshDexSparklines } from "./sparkline-service";

const FEED = "0x1111111111111111111111111111111111111111" as Address;
const address = (id: number) => `0x${String(id).padStart(40, "0")}` as Address;
const asset = (id: number, over: Partial<B20Asset> = {}) => ({ address: address(id), canonicalId: address(id), status: "active", totalSupply: 100n, ...over }) as B20Asset;
const withFeed = (id: number) => asset(id, { oracle: { feed: FEED } as B20Asset["oracle"] });
const key = (id: number) => `ohlcv:${address(id)}:1W`;
/** Hourly candles ending now, rising one dollar an hour. */
const hourly = (n: number, endMs = Date.now()): Candle[] => Array.from({ length: n }, (_, i) => {
  const close = 100 + i;
  return { time: Math.floor(endMs / 1000) - (n - 1 - i) * 3600, open: close, high: close, low: close, close, volume: 1 };
});

beforeEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  resetLastGoodMemory();
  await invalidate("");
  h.rounds.mockResolvedValue([]);
});

describe("sparklines", () => {
  it("draws a stock with a feed from Chainlink rounds", async () => {
    const now = Math.floor(Date.now() / 1000);
    h.rounds.mockResolvedValue([{ time: now - 3 * 86_400, price: 10 }, { time: now - 3_600, price: 12 }]);
    const { d1, d7 } = await getSparklines([withFeed(1)]);
    expect(d7[address(1)]).toHaveLength(32);
    expect(d7[address(1)]!.at(0)).toBe(10);
    expect(d1[address(1)]!.at(-1)).toBe(12);
  });

  it("draws a stock without a feed from its remembered pool candles, without fetching", async () => {
    rememberGood(key(2), hourly(168));
    const { d1, d7 } = await getSparklines([asset(2)]);
    expect(h.series).not.toHaveBeenCalled();
    expect(d7[address(2)]).toHaveLength(32);
    expect(d7[address(2)]!.at(-1)).toBe(267);
    expect(d1[address(2)]!.at(-1)).toBe(267);
    expect(d1[address(2)]!.at(0)).toBeGreaterThan(d7[address(2)]!.at(0)!);
  });

  it("leaves a stock out rather than draw a series that ended half a day ago", async () => {
    rememberGood(key(2), hourly(168), Date.now() - 13 * 3600_000);
    const { d7 } = await getSparklines([asset(2)]);
    expect(d7[address(2)]).toBeUndefined();
  });

  it("draws nothing for a stock that is not issued", async () => {
    rememberGood(key(3), hourly(168));
    const { d7 } = await getSparklines([asset(3, { totalSupply: 0n })]);
    expect(d7[address(3)]).toBeUndefined();
  });
});

describe("pool series refresh", () => {
  beforeEach(() => {
    h.series.mockImplementation(async () => ({ candles: hourly(10), source: "market", timeframe: "1W" }));
  });

  it("fetches the missing and the oldest first, a few per call, and skips fresh ones and stocks with a feed", async () => {
    rememberGood(key(1), hourly(10), Date.now() - 5 * 60_000); // fresh
    rememberGood(key(2), hourly(10), Date.now() - 3 * 3600_000); // old
    rememberGood(key(3), hourly(10), Date.now() - 6 * 3600_000); // oldest
    const assets = [asset(1), asset(2), asset(3), asset(4), withFeed(5), asset(6, { totalSupply: 0n })];
    expect(await refreshDexSparklines(assets, 2)).toBe(2);
    expect(h.series.mock.calls.map((c) => c[0].address)).toEqual([address(4), address(3)]);
    expect(h.series.mock.calls.every((c) => c[1] === "1W")).toBe(true);
  });

  it("counts only the series it could fetch", async () => {
    h.series.mockImplementation(async (subject: { address: Address }) => (subject.address === address(1) ? { candles: [], source: "reference", timeframe: "1W" } : { candles: hourly(10), source: "market", timeframe: "1W" }));
    expect(await refreshDexSparklines([asset(1), asset(2)])).toBe(1);
  });

  it("does nothing while another refresh is running", async () => {
    let release: () => void = () => undefined;
    h.series.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ candles: hourly(10), source: "market", timeframe: "1W" }); }));
    const first = refreshDexSparklines([asset(1)]);
    await vi.waitFor(() => expect(h.series).toHaveBeenCalledTimes(1));
    expect(await refreshDexSparklines([asset(1)])).toBe(0);
    release();
    expect(await first).toBe(1);
  });
});
