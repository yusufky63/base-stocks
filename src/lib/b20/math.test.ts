import { describe, expect, it } from "vitest";
import { WAD, toScaled, toRaw, multiplierToNumber, equityPricePerShare, rawValueUsd, parseAmountSafe, bpsOf, splitByWeights } from "./math";

describe("B20 multiplier math", () => {
  it("scaled equals raw when multiplier is 1.0", () => {
    expect(toScaled(100_000_000n, WAD)).toBe(100_000_000n);
    expect(toRaw(100_000_000n, WAD)).toBe(100_000_000n);
  });

  it("doubles displayed balance on a 2-for-1 split (multiplier 2e18) while raw is unchanged", () => {
    const raw = 100n * 10n ** 8n;
    const scaled = toScaled(raw, 2n * WAD);
    expect(scaled).toBe(200n * 10n ** 8n);
    expect(toRaw(scaled, 2n * WAD)).toBe(raw);
  });

  it("reflects a dividend multiplier of 1.02", () => {
    const m = (102n * WAD) / 100n;
    expect(toScaled(10n ** 8n, m)).toBe(102_000_000n);
    expect(multiplierToNumber(m)).toBeCloseTo(1.02, 10);
  });

  it("does not double-apply the multiplier to a total-return token price", () => {
    // Feed price is per raw token and already multiplier-adjusted.
    const tokenPrice = 218.8;
    const raw = 5n * 10n ** 8n;
    expect(rawValueUsd(raw, 8, tokenPrice)).toBeCloseTo(1094, 6);
    expect(equityPricePerShare(tokenPrice, 2n * WAD)).toBeCloseTo(109.4, 6);
  });

  it("throws on zero multiplier when converting to raw", () => {
    expect(() => toRaw(1n, 0n)).toThrow();
  });
});

describe("amount helpers", () => {
  it("parses human amounts safely", () => {
    expect(parseAmountSafe("25", 6)).toBe(25_000_000n);
    expect(parseAmountSafe("0.5", 8)).toBe(50_000_000n);
    expect(parseAmountSafe("", 6)).toBe(0n);
    expect(parseAmountSafe("abc", 6)).toBe(0n);
    expect(parseAmountSafe("1,000", 6)).toBe(1_000_000_000n);
  });

  it("computes bps of a balance", () => {
    expect(bpsOf(1_000n, 2500)).toBe(250n);
    expect(bpsOf(1_000n, 10_000)).toBe(1_000n);
    expect(() => bpsOf(1n, 10_001)).toThrow();
  });

  it("splits totals by weight without losing cents", () => {
    const parts = splitByWeights(10_001n, [3333, 3333, 3334]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(10_001n);
    expect(parts[2]).toBeGreaterThanOrEqual(parts[0]!);
  });
});
