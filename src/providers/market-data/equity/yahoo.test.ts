import { describe, expect, it } from "vitest";
import { parseChart, yahooSymbol } from "./yahoo";

const chart = (meta: Record<string, unknown>, timestamp: number[] = [], close: Array<number | null> = []) => ({ chart: { result: [{ meta: { symbol: "PLTR", currency: "USD", ...meta }, timestamp, indicators: { quote: [{ close }] } }] } });

describe("parseChart", () => {
  it("reads the last regular-session price and the hourly closes, skipping empty hours", () => {
    const q = parseChart(chart({ regularMarketPrice: 188.75, regularMarketTime: 1_790_971_200 }, [1, 2, 3], [187, null, 188.5]));
    expect(q).toEqual({ symbol: "PLTR", priceUsd: 188.75, updatedAt: 1_790_971_200_000, points: [{ time: 1, price: 187 }, { time: 3, price: 188.5 }] });
  });

  it("refuses a quote in another currency rather than read it as dollars", () => {
    expect(parseChart(chart({ currency: "EUR", regularMarketPrice: 10, regularMarketTime: 1 }))).toBeNull();
  });

  it("refuses an answer without a price or a time", () => {
    expect(parseChart(chart({ regularMarketPrice: null, regularMarketTime: 1 }))).toBeNull();
    expect(parseChart(chart({ regularMarketPrice: 10 }))).toBeNull();
    expect(parseChart({ chart: { result: null, error: { code: "Not Found" } } })).toBeNull();
    expect(parseChart("nonsense")).toBeNull();
  });
});

describe("yahooSymbol", () => {
  it("writes share classes the way Yahoo does", () => {
    expect(yahooSymbol("BRK.B")).toBe("BRK-B");
    expect(yahooSymbol(" pltr ")).toBe("PLTR");
  });
});
