import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { assessFunding, autoInvestAddressOf, cadenceToInterval, decodePlan, intervalToCadenceDays, isKnownAutoInvest, KNOWN_AUTO_INVEST_ADDRESSES, LEGACY_AUTO_INVEST_ADDRESSES, legAmountIn, legsFromAllocations, usdToUsdc, usdcToUsd, type PlanTuple } from "./index";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const AAPL = "0xb200000000000000000000C2e324d24d7eEcd1fb" as Address;
const ALICE = "0x78de409a6306550882328E2a67160471368387FF" as Address;
const V1 = "0xc767844F2D65ba241DBe2c04f9c01d05cCD9b60E" as Address;
const V2 = "0x1111111111111111111111111111111111111111" as Address;

describe("plan legs from a basket", () => {
  it("drops the cash share and re-normalises the stocks to 100%", () => {
    const { assets, weightsBps } = legsFromAllocations([
      { assetAddress: NVDA, weightBps: 4000 },
      { assetAddress: AAPL, weightBps: 4000 },
      { assetAddress: "USDC", weightBps: 2000 },
    ]);
    expect(assets).toEqual([NVDA, AAPL]);
    expect(weightsBps).toEqual([5000, 5000]);
  });

  it("puts the rounding remainder on the largest leg", () => {
    const { weightsBps } = legsFromAllocations([
      { assetAddress: NVDA, weightBps: 3334 },
      { assetAddress: AAPL, weightBps: 3333 },
      { assetAddress: "0xb2000000000000000000008bC8786B856E61707C", weightBps: 3333 },
    ]);
    expect(weightsBps.reduce((s, w) => s + w, 0)).toBe(10_000);
  });

  it("returns nothing for a cash-only basket", () => {
    expect(legsFromAllocations([{ assetAddress: "USDC", weightBps: 10_000 }])).toEqual({ assets: [], weightsBps: [] });
  });
});

describe("amounts", () => {
  it("round-trips dollars and USDC units", () => {
    expect(usdToUsdc(25)).toBe(25_000_000n);
    expect(usdToUsdc(0.1)).toBe(100_000n);
    expect(usdcToUsd(25_000_000n)).toBe(25);
  });

  it("caps a leg exactly as the contract does (floor of the weighted share)", () => {
    expect(legAmountIn(100_000_000n, 6000)).toBe(60_000_000n);
    expect(legAmountIn(100_000_000n, 3333)).toBe(33_330_000n);
    expect(legAmountIn(1_000_000n, 1)).toBe(100n);
  });

  it("maps cadences to seconds and back, never below the contract minimum", () => {
    expect(cadenceToInterval(7)).toBe(7 * 86_400);
    expect(intervalToCadenceDays(7 * 86_400)).toBe(7);
    expect(cadenceToInterval(0)).toBe(3600);
    expect(intervalToCadenceDays(3600)).toBe(1);
  });
});

describe("funding", () => {
  it("needs both the balance and the allowance to cover one run", () => {
    expect(assessFunding(50_000_000n, 1_000_000_000n, 25_000_000n)).toMatchObject({ enough: true, runsCovered: 40 });
    expect(assessFunding(10_000_000n, 1_000_000_000n, 25_000_000n).enough).toBe(false);
    expect(assessFunding(50_000_000n, 20_000_000n, 25_000_000n)).toMatchObject({ enough: false, runsCovered: 0 });
  });
});

describe("decoding an onchain plan", () => {
  it("turns the tuple into named fields and a status word", () => {
    const tuple: PlanTuple = [ALICE, 25_000_000n, 604_800, 1_800_000_000, 0, 300, 3, 1_799_395_200, 1];
    const plan = decodePlan(V1, 7n, tuple, [{ asset: NVDA, weightBps: 10_000 }]);
    expect(plan).toMatchObject({ contract: V1, planId: 7n, owner: ALICE, amountPerRun: 25_000_000n, interval: 604_800, nextRunAt: 1_800_000_000, expiry: 0, maxSlippageBps: 300, runs: 3, status: "paused" });
    expect(plan.legs).toEqual([{ asset: NVDA, weightBps: 10_000 }]);
  });
});

describe("which contract a plan lives in", () => {
  it("lists the first deployment as legacy and knows it whatever the env says", () => {
    expect(LEGACY_AUTO_INVEST_ADDRESSES[0]).toBe(V1);
    expect(KNOWN_AUTO_INVEST_ADDRESSES.map((a) => a.toLowerCase())).toContain(V1.toLowerCase());
    expect(isKnownAutoInvest(V1)).toBe(true);
    expect(isKnownAutoInvest(V1.toLowerCase())).toBe(true);
    expect(isKnownAutoInvest(undefined)).toBe(false);
    expect(isKnownAutoInvest("0x0000000000000000000000000000000000000000")).toBe(false);
  });

  it("never lists an address twice, however it is cased", () => {
    const lower = KNOWN_AUTO_INVEST_ADDRESSES.map((a) => a.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });

  it("reads the contract a mirror recorded, and falls back to the first deployment when it has none", () => {
    expect(autoInvestAddressOf({ config: { onchain: { contract: V2 } } })).toBe(V2);
    // Mirrors written before the contract was recorded per plan all predate the second deployment.
    expect(autoInvestAddressOf({ config: { onchain: {} } })).toBe(V1);
    expect(autoInvestAddressOf({ config: {} })).toBe(V1);
    expect(autoInvestAddressOf({ config: { onchain: { contract: "not an address" } } })).toBe(V1);
    expect(autoInvestAddressOf({ config: { onchain: { contract: "0x0000000000000000000000000000000000000000" } } })).toBe(V1);
  });
});
