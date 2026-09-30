import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import { holdingReturn } from "./holding-return";

const WAD = 10n ** 18n;
const units = (n: string) => parseUnits(n, 8);

describe("holdingReturn", () => {
  it("prices the covered shares against what was paid", () => {
    const r = holdingReturn({ costUsd: 200, coveredRaw: units("1"), rawBalance: units("1"), decimals: 8, multiplierWad: WAD, priceUsd: 250 });
    expect(r?.avgCostPerShare).toBeCloseTo(200);
    expect(r?.pricePerShare).toBeCloseTo(250);
    expect(r?.unrealisedUsd).toBeCloseTo(50);
    expect(r?.returnPct).toBeCloseTo(25);
    expect(r?.partial).toBe(false);
  });

  it("leaves the return alone when a 2-for-1 split doubles the shares", () => {
    // Total-return feed: the token price is unchanged, the multiplier doubles, each share is worth half.
    const before = holdingReturn({ costUsd: 200, coveredRaw: units("1"), rawBalance: units("1"), decimals: 8, multiplierWad: WAD, priceUsd: 250 });
    const after = holdingReturn({ costUsd: 200, coveredRaw: units("1"), rawBalance: units("1"), decimals: 8, multiplierWad: 2n * WAD, priceUsd: 250 });
    expect(after?.coveredShares).toBeCloseTo(2);
    expect(after?.avgCostPerShare).toBeCloseTo(100);
    expect(after?.pricePerShare).toBeCloseTo(125);
    expect(after?.returnPct).toBeCloseTo(before!.returnPct!);
  });

  it("says when part of the holding has no purchase price", () => {
    const r = holdingReturn({ costUsd: 100, coveredRaw: units("0.4"), rawBalance: units("1"), decimals: 8, multiplierWad: WAD, priceUsd: 300 });
    expect(r?.partial).toBe(true);
    expect(r?.coveredShares).toBeCloseTo(0.4);
    expect(r?.avgCostPerShare).toBeCloseTo(250);
    expect(r?.returnPct).toBeCloseTo(20);
  });

  it("shrinks the basis with the holding when the ledger is ahead of the wallet", () => {
    const r = holdingReturn({ costUsd: 200, coveredRaw: units("2"), rawBalance: units("1"), decimals: 8, multiplierWad: WAD, priceUsd: 100 });
    expect(r?.costUsd).toBeCloseTo(100);
    expect(r?.returnPct).toBeCloseTo(0);
  });

  it("has no return without a price, and nothing at all without a purchase", () => {
    const unpriced = holdingReturn({ costUsd: 200, coveredRaw: units("1"), rawBalance: units("1"), decimals: 8, multiplierWad: WAD, priceUsd: null });
    expect(unpriced?.returnPct).toBeNull();
    expect(unpriced?.avgCostPerShare).toBeCloseTo(200);
    expect(holdingReturn({ costUsd: 0, coveredRaw: 0n, rawBalance: units("1"), decimals: 8, multiplierWad: WAD, priceUsd: 250 })).toBeNull();
    expect(holdingReturn({ costUsd: 200, coveredRaw: units("1"), rawBalance: 0n, decimals: 8, multiplierWad: WAD, priceUsd: 250 })).toBeNull();
  });
});
