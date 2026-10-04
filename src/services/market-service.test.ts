import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { Candle } from "@/domain/market";

const h = vi.hoisted(() => ({ ohlcv: vi.fn(), rounds: vi.fn() }));
vi.mock("@/providers/market-data", () => ({ getMarketDataProvider: () => ({ id: "test", getTokenOhlcv: h.ohlcv }) }));
vi.mock("@/providers/market-data/chainlink/history", () => ({
  readRoundHistory: h.rounds,
  roundsToCandles: (rounds: Array<{ time: number; price: number }>): Candle[] => rounds.map((r) => ({ time: r.time, open: r.price, high: r.price, low: r.price, close: r.price, volume: 0 })),
}));
vi.mock("./price-service", () => ({ peekMarketData: async () => null }));
vi.mock("@/lib/shared-store", () => ({ getSharedStore: () => null }));

import { resetLastGoodMemory } from "@/lib/last-good";
import { getChartSeries } from "./market-service";

const STOCK = "0xb2000000000000000000007d16372840df4dabbe" as Address;
const FEED = "0x1111111111111111111111111111111111111111" as Address;
const candles = (n: number): Candle[] => Array.from({ length: n }, (_, i) => ({ time: 1_000 + i * 60, open: 100, high: 101, low: 99, close: 100, volume: 1 }));

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  resetLastGoodMemory();
});

describe("chart series for a stock without a feed", () => {
  it("serves the last good DEX series when the candle provider is throttled", async () => {
    h.ohlcv.mockResolvedValue(candles(40));
    expect((await getChartSeries({ address: STOCK, feed: null }, "1M")).source).toBe("market");
    h.ohlcv.mockRejectedValue(new Error("geckoterminal: rate limited"));
    const series = await getChartSeries({ address: STOCK, feed: null }, "1M");
    expect(series.source).toBe("market");
    expect(series.candles).toHaveLength(40);
  });

  it("keeps the remembered series per range and drops it after a day", async () => {
    h.ohlcv.mockResolvedValue(candles(40));
    await getChartSeries({ address: STOCK, feed: null }, "1M");
    h.ohlcv.mockResolvedValue([]);
    expect((await getChartSeries({ address: STOCK, feed: null }, "1W")).candles).toEqual([]);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 25 * 3600_000);
    expect((await getChartSeries({ address: STOCK, feed: null }, "1M")).candles).toEqual([]);
  });
});

describe("chart series for a stock with a feed", () => {
  it("falls back to the reference history, never to a remembered series", async () => {
    h.ohlcv.mockResolvedValue(candles(40));
    await getChartSeries({ address: STOCK, feed: FEED }, "1M");
    h.ohlcv.mockRejectedValue(new Error("down"));
    h.rounds.mockResolvedValue([{ time: 1, price: 10 }, { time: 2, price: 11 }]);
    const series = await getChartSeries({ address: STOCK, feed: FEED }, "1M");
    expect(series.source).toBe("reference");
    expect(series.candles).toHaveLength(2);
  });
});
