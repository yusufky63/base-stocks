import { describe, expect, it } from "vitest";
import { hasMeaningfulChange, sortByTradingStatus, tradingStatus } from "./trading-status";

const asset = (over: { status?: "active" | "paused"; totalSupply?: string } = {}) => ({
  status: over.status ?? ("active" as const),
  totalSupply: over.totalSupply ?? "100000000000",
});
const price = (liquidityUsd: number | null, volume24hUsd: number | null = null) => ({ liquidityUsd, volume24hUsd });

describe("trading status", () => {
  it("puts issuance and pauses ahead of any liquidity question", () => {
    expect(tradingStatus(asset({ status: "paused" }), price(5_000_000)).status).toBe("paused");
    expect(tradingStatus(asset({ totalSupply: "0" }), price(5_000_000)).status).toBe("not-issued");
  });

  it("classifies by liquidity across the whole range", () => {
    expect(tradingStatus(asset(), price(2_100_000)).status).toBe("tradable");
    expect(tradingStatus(asset(), price(27_905)).status).toBe("thin");
    expect(tradingStatus(asset(), price(108)).status).toBe("very-thin");
    expect(tradingStatus(asset(), price(0)).status).toBe("no-pool");
    expect(tradingStatus(asset(), price(null)).status).toBe("no-pool");
    expect(tradingStatus(asset(), null).status).toBe("no-pool");
  });

  it("holds the thresholds exactly at the boundary", () => {
    expect(tradingStatus(asset(), price(100_000)).status).toBe("tradable");
    expect(tradingStatus(asset(), price(99_999)).status).toBe("thin");
    expect(tradingStatus(asset(), price(10_000)).status).toBe("thin");
    expect(tradingStatus(asset(), price(9_999)).status).toBe("very-thin");
    expect(tradingStatus(asset(), price(1)).status).toBe("very-thin");
  });

  /**
   * The bug the six new listings exposed: a $9,920 pool was labelled "No pool yet" while its own
   * detail line printed the pool size. A label must never contradict the text under it.
   */
  it("never says there is no pool while reporting one", () => {
    for (const liq of [1, 108, 515, 3_004, 9_920, 9_999]) {
      const view = tradingStatus(asset(), price(liq));
      expect(view.label).not.toBe("No pool yet");
      expect(view.detail).toContain("liquidity");
    }
    const empty = tradingStatus(asset(), price(0));
    expect(empty.label).toBe("No pool yet");
    expect(empty.detail).not.toMatch(/\$\d/);
  });

  it("warns about slippage exactly where it matters", () => {
    expect(tradingStatus(asset(), price(108)).detail).toContain("expect heavy slippage");
    expect(tradingStatus(asset(), price(27_905)).detail).not.toContain("slippage");
    expect(tradingStatus(asset(), price(2_100_000)).detail).not.toContain("slippage");
  });

  it("appends 24h volume only when there is some", () => {
    expect(tradingStatus(asset(), price(2_100_000, 6_200_000)).detail).toBe("$2.1M liquidity · $6.2M 24h");
    expect(tradingStatus(asset(), price(2_100_000, 0)).detail).toBe("$2.1M liquidity");
    expect(tradingStatus(asset(), price(2_100_000, null)).detail).toBe("$2.1M liquidity");
  });

  /**
   * The second thing the six listings exposed: a pool created hours ago has no honest "24h ago",
   * so the DEX reported Microsoft down 82% while its price sat 1% from the Chainlink reference.
   */
  it("only trusts a 24h move from a market deep enough to make one", () => {
    expect(hasMeaningfulChange(tradingStatus(asset(), price(2_100_000)).status)).toBe(true);
    expect(hasMeaningfulChange(tradingStatus(asset(), price(27_905)).status)).toBe(true);
    expect(hasMeaningfulChange(tradingStatus(asset(), price(9_979)).status)).toBe(false);
    expect(hasMeaningfulChange(tradingStatus(asset(), price(108)).status)).toBe(false);
    expect(hasMeaningfulChange(tradingStatus(asset(), price(0)).status)).toBe(false);
    expect(hasMeaningfulChange(tradingStatus(asset({ totalSupply: "0" }), price(0)).status)).toBe(false);
    expect(hasMeaningfulChange(tradingStatus(asset({ status: "paused" }), price(5_000_000)).status)).toBe(false);
  });

  it("orders deepest first and keeps input order within a tier", () => {
    const rows = [
      { name: "SNDK", asset: asset(), price: price(108) },
      { name: "COIN", asset: asset({ totalSupply: "0" }), price: price(0) },
      { name: "NVDA", asset: asset(), price: price(2_100_000) },
      { name: "SPCX", asset: asset(), price: price(27_905) },
      { name: "AAPL", asset: asset(), price: price(1_110_370) },
      { name: "HALT", asset: asset({ status: "paused" }), price: price(500_000) },
    ];
    expect(sortByTradingStatus(rows, (r) => r).map((r) => r.name)).toEqual(["NVDA", "AAPL", "SPCX", "SNDK", "COIN", "HALT"]);
  });
});
