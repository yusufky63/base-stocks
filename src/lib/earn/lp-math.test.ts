import { describe, expect, it } from "vitest";
import { amountsForLiquidity, inRange, sqrtPriceX96ToSqrtPrice, tickToPrice, tickToSqrtPrice } from "./lp-math";

describe("concentrated-liquidity math", () => {
  it("tick 0 is price 1 (same decimals) and sqrt price 1", () => {
    expect(tickToSqrtPrice(0)).toBe(1);
    expect(tickToPrice(0, 18, 18)).toBe(1);
  });

  it("price follows 1.0001^tick and decimal adjustment", () => {
    expect(tickToPrice(1, 18, 18)).toBeCloseTo(1.0001, 10);
    // USDC(6) quoted in a token with 8 decimals shifts by 10^(6-8)
    expect(tickToPrice(0, 6, 8)).toBeCloseTo(0.01, 12);
    expect(tickToSqrtPrice(2) ** 2).toBeCloseTo(tickToPrice(2, 18, 18), 10);
  });

  it("converts sqrtPriceX96 from Q96 fixed point", () => {
    expect(sqrtPriceX96ToSqrtPrice(2n ** 96n)).toBeCloseTo(1, 12);
    expect(sqrtPriceX96ToSqrtPrice(2n ** 97n)).toBeCloseTo(2, 12);
  });

  it("splits liquidity into both tokens inside the range", () => {
    const L = 1_000_000n;
    const price = tickToSqrtPrice(0);
    const { amount0, amount1 } = amountsForLiquidity(L, price, -1000, 1000);
    expect(amount0).toBeGreaterThan(0);
    expect(amount1).toBeGreaterThan(0);
    // Symmetric range around the current tick holds near-equal values of each side.
    expect(amount0 / amount1).toBeCloseTo(1, 2);
  });

  it("goes fully one-sided outside the range", () => {
    const L = 1_000_000n;
    const below = amountsForLiquidity(L, tickToSqrtPrice(-2000), -1000, 1000);
    expect(below.amount1).toBe(0);
    expect(below.amount0).toBeGreaterThan(0);
    const above = amountsForLiquidity(L, tickToSqrtPrice(2000), -1000, 1000);
    expect(above.amount0).toBe(0);
    expect(above.amount1).toBeGreaterThan(0);
  });

  it("amounts are continuous at the range edges", () => {
    const L = 5_000_000n;
    const edge = amountsForLiquidity(L, tickToSqrtPrice(1000), -1000, 1000);
    const above = amountsForLiquidity(L, tickToSqrtPrice(1000) + 1e-9, -1000, 1000);
    expect(edge.amount0).toBeCloseTo(above.amount0, 6);
    expect(edge.amount1).toBeCloseTo(above.amount1, 0);
  });

  it("inRange uses the half-open convention of the pools", () => {
    expect(inRange(-1000, -1000, 1000)).toBe(true);
    expect(inRange(999, -1000, 1000)).toBe(true);
    expect(inRange(1000, -1000, 1000)).toBe(false);
    expect(inRange(-1001, -1000, 1000)).toBe(false);
  });
});
