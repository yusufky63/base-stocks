import { describe, expect, it } from "vitest";
import { estimateFeeApyPct, liquidityRiskLabel } from "./fee-apy";

describe("estimateFeeApyPct", () => {
  it("annualises one day of fees over the pool's depth", () => {
    // $100k of volume a day at 0.3% is $300 a day; over $1M of liquidity that is 10.95% a year.
    expect(estimateFeeApyPct(100_000, 0.003, 1_000_000)).toBeCloseTo(10.95, 2);
  });
  it("refuses pools too shallow to trust, where a few dollars of volume reads as a huge rate", () => {
    expect(estimateFeeApyPct(5_000, 0.003, 9_999)).toBeUndefined();
    expect(estimateFeeApyPct(5_000, 0.003, 10_000)).toBeDefined();
  });
  it("refuses an implausible result rather than printing it", () => {
    expect(estimateFeeApyPct(50_000_000, 0.01, 10_000)).toBeUndefined(); // tens of thousands of percent
  });
  it("needs all three inputs to be present and non-zero", () => {
    expect(estimateFeeApyPct(null, 0.003, 1_000_000)).toBeUndefined();
    expect(estimateFeeApyPct(100_000, 0, 1_000_000)).toBeUndefined();
    expect(estimateFeeApyPct(100_000, 0.003, undefined)).toBeUndefined();
    expect(estimateFeeApyPct(0, 0.003, 1_000_000)).toBeUndefined();
  });
});

describe("liquidityRiskLabel", () => {
  it("treats only deep USDC pools as ordinary LP risk", () => {
    expect(liquidityRiskLabel("USDC", 100_000)).toBe("medium");
    expect(liquidityRiskLabel("USDC", 99_999)).toBe("higher");
    expect(liquidityRiskLabel("WETH", 10_000_000)).toBe("higher");
    expect(liquidityRiskLabel(null, null)).toBe("higher");
  });
});
