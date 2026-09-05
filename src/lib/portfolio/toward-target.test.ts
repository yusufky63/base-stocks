import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { PortfolioSnapshot } from "@/domain/portfolio";
import { TOTAL_BPS } from "@/domain/portfolio";
import { towardTargetRun } from "./toward-target";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const AAPL = "0xb200000000000000000000C2e324d24d7eEcd1fb" as Address;
const META = "0xb2000000000000000000008bC8786B856E61707C" as Address;

function snapshot(holdings: Array<{ assetAddress: Address; marketValueUsd: number }>, usdcValueUsd = 0): Pick<PortfolioSnapshot, "holdings" | "usdcValueUsd"> {
  return { holdings: holdings.map((h) => ({ ...h, underlying: "X" })) as PortfolioSnapshot["holdings"], usdcValueUsd };
}

const thirds = [
  { assetAddress: NVDA, weightBps: 3400 },
  { assetAddress: AAPL, weightBps: 3300 },
  { assetAddress: META, weightBps: 3300 },
];

describe("a run toward the target", () => {
  /** NVDA ran up: it is over, the other two are under. Only the two under are bought, and only in proportion to their gaps. */
  it("buys only what is under target, split by how far under each leg is", () => {
    const run = towardTargetRun(snapshot([{ assetAddress: NVDA, marketValueUsd: 700 }, { assetAddress: AAPL, marketValueUsd: 200 }, { assetAddress: META, marketValueUsd: 100 }]), thirds, 50);
    expect(run).not.toBeNull();
    const addresses = run!.allocations.map((a) => a.assetAddress);
    expect(addresses).not.toContain(NVDA);
    expect(addresses).toContain(AAPL);
    expect(addresses).toContain(META);
    // META is $230 under, AAPL $130 under: META gets the larger share, and the weights add to exactly 100%.
    const meta = run!.allocations.find((a) => a.assetAddress === META)!.weightBps;
    const aapl = run!.allocations.find((a) => a.assetAddress === AAPL)!.weightBps;
    expect(meta).toBeGreaterThan(aapl);
    expect(meta + aapl).toBe(TOTAL_BPS);
    expect(run!.totalUsd).toBe(50);
  });

  /** A small gap does not get the whole budget: the run spends what closes the gap, no more. */
  it("spends no more than the gap", () => {
    const run = towardTargetRun(snapshot([{ assetAddress: NVDA, marketValueUsd: 340 }, { assetAddress: AAPL, marketValueUsd: 330 }, { assetAddress: META, marketValueUsd: 310 }]), thirds, 100);
    expect(run).not.toBeNull();
    expect(run!.totalUsd).toBeLessThan(100);
    expect(run!.totalUsd).toBeCloseTo(13.4, 5); // META: 33% of the $980 base is $323.40, and it holds $310
  });

  it("is null when every leg is within threshold, so the run is logged as in balance", () => {
    expect(towardTargetRun(snapshot([{ assetAddress: NVDA, marketValueUsd: 340 }, { assetAddress: AAPL, marketValueUsd: 330 }, { assetAddress: META, marketValueUsd: 330 }]), thirds, 50)).toBeNull();
  });

  /** A wallet holding nothing has no base to measure against; the run does not invent one. */
  it("is null for an empty wallet and for a zero amount", () => {
    expect(towardTargetRun(snapshot([]), thirds, 50)).toBeNull();
    expect(towardTargetRun(snapshot([{ assetAddress: NVDA, marketValueUsd: 700 }]), thirds, 0)).toBeNull();
  });

  /** A stock-only target never buys cash and never proposes a sell. */
  it("never proposes a sell", () => {
    const run = towardTargetRun(snapshot([{ assetAddress: NVDA, marketValueUsd: 900 }, { assetAddress: AAPL, marketValueUsd: 50 }, { assetAddress: META, marketValueUsd: 50 }]), thirds, 500);
    expect(run!.allocations.every((a) => a.weightBps > 0)).toBe(true);
    expect(run!.allocations.map((a) => a.assetAddress)).not.toContain("USDC");
  });
});
