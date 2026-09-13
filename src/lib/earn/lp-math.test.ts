import { describe, expect, it } from "vitest";
import { alignTick, amountsForLiquidity, amountsForOneSide, inRange, priceToTick, rangeUsd, sqrtPriceX96ToSqrtPrice, tickToPrice, tickToSqrtPrice } from "./lp-math";

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

  it("priceToTick inverts tickToPrice and alignTick snaps to spacing", () => {
    for (const t of [-5000, -60, 0, 60, 12345]) {
      expect(priceToTick(Math.pow(1.0001, t))).toBeCloseTo(t, 6);
    }
    expect(alignTick(123, 60, "down")).toBe(120);
    expect(alignTick(123, 60, "up")).toBe(180);
    expect(alignTick(-123, 60, "down")).toBe(-180);
    expect(alignTick(-123, 60, "up")).toBe(-120);
    expect(alignTick(9_999_999, 200, "up")).toBe(Math.floor(887272 / 200) * 200);
  });

  it("amountsForOneSide round-trips with amountsForLiquidity in range", () => {
    const sqrtP = tickToSqrtPrice(50);
    const r = amountsForOneSide(sqrtP, -1000, 1000, { amount0: 5_000_000 });
    expect(r.amount0).toBeCloseTo(5_000_000, 3);
    const check = amountsForLiquidity(BigInt(Math.round(r.liquidity)), sqrtP, -1000, 1000);
    expect(check.amount0).toBeCloseTo(r.amount0, 0);
    expect(check.amount1).toBeCloseTo(r.amount1, 0);
    // Deriving from the counterpart amount lands on the same liquidity.
    const back = amountsForOneSide(sqrtP, -1000, 1000, { amount1: r.amount1 });
    expect(back.liquidity / r.liquidity).toBeCloseTo(1, 9);
    expect(back.amount0).toBeCloseTo(r.amount0, 3);
  });

  it("one-sided ranges need only one token", () => {
    const sqrtP = tickToSqrtPrice(0);
    const above = amountsForOneSide(sqrtP, 100, 2000, { amount0: 1_000_000 }); // range above price → token0 only
    expect(above.amount1).toBe(0);
    expect(above.amount0).toBeCloseTo(1_000_000, 3);
    const below = amountsForOneSide(sqrtP, -2000, -100, { amount1: 1_000_000 }); // range below price → token1 only
    expect(below.amount0).toBe(0);
    expect(below.amount1).toBeCloseTo(1_000_000, 3);
  });
});

describe("rangeUsd", () => {
  // An 8-decimal stock against 6-decimal USDC: tickToPrice adjusts for the decimals, so the
  // USD-per-token figure is the raw pool price scaled by 10^(8-6).
  const stock = { decimals: 8, isStock: true, priceUsd: 180 };
  const usdc = { decimals: 6, isStock: false, priceUsd: 1 };

  it("converts a stock/USDC range to USD per stock token and orders the bounds", () => {
    const lower = Math.round(Math.log(150 / 100) / Math.log(1.0001));
    const upper = Math.round(Math.log(200 / 100) / Math.log(1.0001));
    const r = rangeUsd({ tickLower: lower, tickUpper: upper, currentTick: Math.round((lower + upper) / 2) }, stock, usdc)!;
    expect(r.lower).toBeCloseTo(150, 0);
    expect(r.upper).toBeCloseTo(200, 0);
    expect(r.current).toBeGreaterThan(r.lower);
    expect(r.current).toBeLessThan(r.upper);
  });

  it("inverts the price when the stock is token1, so lower still means lower in USD", () => {
    // token0 = USDC (6), token1 = stock (8): pool price is stock per USDC; a higher tick is a cheaper stock.
    const lower = Math.round(Math.log((1 / 200) * 100) / Math.log(1.0001));
    const upper = Math.round(Math.log((1 / 150) * 100) / Math.log(1.0001));
    const r = rangeUsd({ tickLower: lower, tickUpper: upper, currentTick: lower }, usdc, stock)!;
    expect(r.lower).toBeCloseTo(150, 0);
    expect(r.upper).toBeCloseTo(200, 0);
  });

  it("prices the quote leg in its own USD price (WETH), not in dollars", () => {
    const weth = { decimals: 18, isStock: false, priceUsd: 4_000 };
    // 1 stock token = 0.05 WETH: raw token1 per raw token0 is 0.05 * 10^(18-8).
    const tick = Math.round(Math.log(0.05 * 1e10) / Math.log(1.0001));
    const r = rangeUsd({ tickLower: tick, tickUpper: tick + 1, currentTick: tick }, stock, weth)!;
    expect(r.lower).toBeCloseTo(200, 0);
  });

  it("has nothing to say without a stock or without a quote price", () => {
    expect(rangeUsd({ tickLower: 0, tickUpper: 10, currentTick: 5 }, usdc, { ...usdc })).toBeNull();
    expect(rangeUsd({ tickLower: 0, tickUpper: 10, currentTick: 5 }, stock, { ...usdc, priceUsd: null })).toBeNull();
  });
});
