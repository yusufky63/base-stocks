import { describe, expect, it } from "vitest";
import { tradingStatus } from "@/lib/trading-status";
import { LIQUID_USD, THIN_USD, liveMarketTotals, marketLegend, type MarketRow } from "./live-markets";

const issued = { status: "active", totalSupply: "1", supplyKnown: true } as const;

describe("legend thresholds mirror trading-status", () => {
  it("LIQUID_USD is the first liquidity that reads Live", () => {
    expect(tradingStatus(issued, { liquidityUsd: LIQUID_USD, volume24hUsd: null }).status).toBe("tradable");
    expect(tradingStatus(issued, { liquidityUsd: LIQUID_USD - 1, volume24hUsd: null }).status).toBe("thin");
  });

  it("THIN_USD is the first liquidity that reads Thin", () => {
    expect(tradingStatus(issued, { liquidityUsd: THIN_USD, volume24hUsd: null }).status).toBe("thin");
    expect(tradingStatus(issued, { liquidityUsd: THIN_USD - 1, volume24hUsd: null }).status).toBe("very-thin");
  });

  it("the legend names every status with the chip's own label", () => {
    const legend = marketLegend();
    for (const label of ["Live", "Thin", "Very thin", "No pool yet", "Not issued yet", "Paused"]) expect(legend).toContain(label);
    expect(legend).toContain("$100k");
    expect(legend).toContain("$10k");
    expect(legend).toContain("20%");
    expect(legend).toContain("$20k");
  });
});

describe("liveMarketTotals", () => {
  const row = (liquidityUsd: number | null, change: number | null = null, volume24hUsd: number | null = null): MarketRow =>
    ({ asset: { ...issued, canonicalId: String(liquidityUsd) }, price: { liquidityUsd, volume24hUsd, marketChange24hPct: change } }) as unknown as MarketRow;

  it("counts live and thin markets, not very thin ones", () => {
    const totals = liveMarketTotals([row(2_000_000, 1.2, 50_000), row(50_000, -0.4, 1_000), row(500, 9)]);
    expect(totals.live).toHaveLength(2);
    expect(totals.liquidityUsd).toBe(2_050_000);
    expect(totals.volume24hUsd).toBe(51_000);
    expect(totals.up).toBe(1);
    expect(totals.known).toBe(true);
  });

  it("reports unknown, not zero, when no row has a liquidity figure", () => {
    const totals = liveMarketTotals([row(null), row(null)]);
    expect(totals.live).toHaveLength(0);
    expect(totals.known).toBe(false);
  });
});
