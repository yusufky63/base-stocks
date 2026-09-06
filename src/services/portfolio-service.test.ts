import { describe, expect, it } from "vitest";
import { validateAllocations, buildPlan, rebalanceSuggestions } from "./portfolio-service";
import type { B20Asset } from "@/domain/asset";
import type { PortfolioSnapshot } from "@/domain/portfolio";
import { WAD } from "@/lib/b20/math";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";
const MSFT = "0xB200000000000000000000Ab99cFa739E253872B";

function asset(address: `0x${string}`, symbol: string): B20Asset {
  return {
    address,
    canonicalId: address.toLowerCase(),
    name: symbol,
    symbol,
    underlying: symbol.replace(/c$/, ""),
    decimals: 8,
    tags: ["technology"],
    multiplier: WAD,
    wadPrecision: WAD,
    totalSupply: 1_000_000_00n,
    supplyKnown: true,
    transferSenderPolicyId: 5n,
    transferReceiverPolicyId: 5n,
    transferPaused: false,
    status: "active",
    verification: "verified",
    readAt: 0,
  };
}

describe("validateAllocations", () => {
  it("accepts a valid 100% allocation with USDC", () => {
    const v = validateAllocations([
      { assetAddress: NVDA, weightBps: 6000 },
      { assetAddress: "USDC", weightBps: 4000 },
    ]);
    expect(v.ok).toBe(true);
  });

  it("rejects allocations that do not total 100%", () => {
    const v = validateAllocations([{ assetAddress: NVDA, weightBps: 9000 }]);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/100%/);
  });

  it("rejects non-canonical assets and duplicates", () => {
    const v = validateAllocations([
      { assetAddress: "0x0000000000000000000000000000000000000001", weightBps: 5000 },
      { assetAddress: NVDA, weightBps: 2500 },
      { assetAddress: NVDA.toLowerCase() as `0x${string}`, weightBps: 2500 },
    ]);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /not a verified/.test(e))).toBe(true);
    expect(v.errors.some((e) => /Duplicate/.test(e))).toBe(true);
  });
});

describe("buildPlan", () => {
  const assets = [asset(NVDA, "NVDAc"), asset(MSFT, "MSFTc")];

  it("splits USD by weight, keeps USDC, and skips legs under the minimum", () => {
    const plan = buildPlan(
      { source: "custom", allocations: [{ assetAddress: NVDA, weightBps: 7000 }, { assetAddress: MSFT, weightBps: 1000 }, { assetAddress: "USDC", weightBps: 2000 }] },
      100,
      assets,
    );
    expect(plan.keepUsdcUsd).toBe(20);
    expect(plan.legs.map((l) => l.targetUsd)).toEqual([70, 10]);
    expect(plan.legs[0]!.sellAmountUsdc).toBe("70000000");

    const tiny = buildPlan({ source: "custom", allocations: [{ assetAddress: NVDA, weightBps: 9900 }, { assetAddress: MSFT, weightBps: 100 }] }, 20, assets);
    expect(tiny.legs).toHaveLength(1);
    expect(tiny.warnings[0]).toMatch(/below/);
  });

  it("refuses paused assets", () => {
    const paused = { ...asset(MSFT, "MSFTc"), status: "paused" as const, transferPaused: true };
    expect(() => buildPlan({ source: "custom", allocations: [{ assetAddress: MSFT, weightBps: 10_000 }] }, 50, [paused])).toThrow(/not available/);
  });
});

describe("rebalanceSuggestions", () => {
  it("suggests sells for overweight and buys for underweight positions", () => {
    const snapshot: PortfolioSnapshot = {
      owner: "0x0000000000000000000000000000000000000001",
      totalValueUsd: 1000,
      usdcBalance: "0",
      earnValueUsd: 0,
      earnPositions: [],
    lpValueUsd: 0,
    lpPositions: [],
      usdcValueUsd: 0,
      change24hPct: null,
      readAt: 0,
      holdings: [
        { assetAddress: NVDA, symbol: "NVDAc", name: "NVIDIA", underlying: "NVDA", rawBalance: "1", scaledBalance: "1", decimals: 8, multiplier: WAD.toString(), marketValueUsd: 700, referenceValueUsd: null, priceUsd: 1, priceSource: "market", change24hPct: null, currentWeightBps: 7000 },
        { assetAddress: MSFT, symbol: "MSFTc", name: "Microsoft", underlying: "MSFT", rawBalance: "1", scaledBalance: "1", decimals: 8, multiplier: WAD.toString(), marketValueUsd: 300, referenceValueUsd: null, priceUsd: 1, priceSource: "market", change24hPct: null, currentWeightBps: 3000 },
      ],
    };
    const s = rebalanceSuggestions(snapshot, [
      { assetAddress: NVDA, weightBps: 5000 },
      { assetAddress: MSFT, weightBps: 5000 },
    ]);
    const nvda = s.find((x) => x.symbol === "NVDAc")!;
    const msft = s.find((x) => x.symbol === "MSFTc")!;
    expect(nvda.action).toBe("sell");
    expect(nvda.deltaUsd).toBeCloseTo(-200);
    expect(msft.action).toBe("buy");
    expect(msft.deltaUsd).toBeCloseTo(200);
  });
});
