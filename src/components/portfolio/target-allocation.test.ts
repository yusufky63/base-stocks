import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { PortfolioSnapshot } from "@/domain/portfolio";
import { allocationsFromSnapshot, maxDriftBps } from "./TargetAllocation";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const AAPL = "0xb200000000000000000000C2e324d24d7eEcd1fb" as Address;
const META = "0xb2000000000000000000008bC8786B856E61707C" as Address;

function snapshot(holdings: Array<{ assetAddress: Address; marketValueUsd: number }>): PortfolioSnapshot {
  return { holdings, usdcValueUsd: 500 } as unknown as PortfolioSnapshot;
}

describe("saving today's mix as a target", () => {
  it("turns values into weights that add to exactly 100%", () => {
    const a = allocationsFromSnapshot(snapshot([
      { assetAddress: NVDA, marketValueUsd: 600 },
      { assetAddress: AAPL, marketValueUsd: 400 },
    ]));
    expect(a).toEqual([
      { assetAddress: NVDA, weightBps: 6000 },
      { assetAddress: AAPL, weightBps: 4000 },
    ]);
  });

  /** Three equal legs cannot divide 10,000 evenly; the total still has to be exact. */
  it("puts the rounding remainder on the largest leg", () => {
    const a = allocationsFromSnapshot(snapshot([
      { assetAddress: NVDA, marketValueUsd: 100 },
      { assetAddress: AAPL, marketValueUsd: 100 },
      { assetAddress: META, marketValueUsd: 100 },
    ]));
    expect(a.reduce((s, x) => s + x.weightBps, 0)).toBe(10_000);
  });

  /** Cash is what a rebalance moves through, not a share to aim at. */
  it("leaves cash out and ignores unpriced holdings", () => {
    const a = allocationsFromSnapshot(snapshot([
      { assetAddress: NVDA, marketValueUsd: 900 },
      { assetAddress: AAPL, marketValueUsd: 0 },
    ]));
    expect(a).toEqual([{ assetAddress: NVDA, weightBps: 10_000 }]);
  });

  it("returns nothing rather than a target of zero", () => {
    expect(allocationsFromSnapshot(snapshot([]))).toEqual([]);
    expect(allocationsFromSnapshot(snapshot([{ assetAddress: NVDA, marketValueUsd: 0 }]))).toEqual([]);
  });
});

describe("drift against the target", () => {
  const target = [
    { assetAddress: NVDA, weightBps: 5000 },
    { assetAddress: AAPL, weightBps: 5000 },
  ];

  it("is zero when the mix still matches", () => {
    expect(maxDriftBps(snapshot([
      { assetAddress: NVDA, marketValueUsd: 500 },
      { assetAddress: AAPL, marketValueUsd: 500 },
    ]), target)).toBe(0);
  });

  it("reports the worst leg, not the average", () => {
    // 70/30 against a 50/50 target: both legs are 20 points out.
    expect(maxDriftBps(snapshot([
      { assetAddress: NVDA, marketValueUsd: 700 },
      { assetAddress: AAPL, marketValueUsd: 300 },
    ]), target)).toBe(2000);
  });

  /** A leg sold to nothing is the largest drift there is, and must not read as "no drift". */
  it("counts a position that is gone as fully drifted", () => {
    expect(maxDriftBps(snapshot([{ assetAddress: NVDA, marketValueUsd: 1000 }]), target)).toBe(5000);
  });

  it("has nothing to say without a target or without holdings", () => {
    expect(maxDriftBps(snapshot([{ assetAddress: NVDA, marketValueUsd: 100 }]), null)).toBeNull();
    expect(maxDriftBps(snapshot([{ assetAddress: NVDA, marketValueUsd: 100 }]), [])).toBeNull();
    expect(maxDriftBps(snapshot([]), target)).toBeNull();
  });

  it("ignores a cash leg in the target", () => {
    const withCash = [...target, { assetAddress: "USDC" as const, weightBps: 0 }];
    expect(maxDriftBps(snapshot([
      { assetAddress: NVDA, marketValueUsd: 500 },
      { assetAddress: AAPL, marketValueUsd: 500 },
    ]), withCash)).toBe(0);
  });
});
