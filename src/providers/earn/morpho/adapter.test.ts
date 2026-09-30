import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { selectBorrowMarkets } from "./adapter";

/**
 * Which Morpho markets for a stock are shown as borrow venues.
 *
 * The stock markets that opened on Base in September 2026 are all listed by Morpho, and they come in
 * two kinds: a few busy ones at about 90% utilization with a few thousand dollars free, and several
 * with no lenders at all ("$0 free"). The first need showing with their thinness spelled out, the
 * second hiding, listing or not. The figures below are the real ones (Morpho API, 2026-09-24).
 */
const NVDA = "0xb200000000000000000000000000000000000001" as Address;
const OTHER = "0xb200000000000000000000000000000000000002" as Address;

function market(id: string, supplyUsd: number, borrowUsd: number, opts: { listed?: boolean; collateral?: Address } = {}) {
  return {
    marketId: id,
    listed: opts.listed ?? false,
    lltv: "625000000000000000",
    loanAsset: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC" },
    collateralAsset: { address: (opts.collateral ?? NVDA).toLowerCase(), symbol: "NVDAc" },
    state: { borrowApy: 0.12, supplyAssetsUsd: supplyUsd, liquidityAssetsUsd: supplyUsd - borrowUsd, timestamp: 1_790_000_000 },
  };
}

const ids = (v: ReturnType<typeof selectBorrowMarkets>) => v.map((m) => m.market.marketId);

describe("selectBorrowMarkets", () => {
  it("shows a well-used market even when little is left to borrow, and calls it thin", () => {
    const [m] = selectBorrowMarkets([market("used", 10_988, 9_890, { listed: true })], NVDA);
    expect(m?.market.marketId).toBe("used");
    expect(m?.thin).toBe(true);
    expect(m?.utilization).toBeCloseTo(0.9, 2);
  });

  it("hides test markets nobody supplied, and markets with nothing left to lend", () => {
    const out = selectBorrowMarkets([market("empty", 0, 0), market("dust", 98, 1), market("three-dollars", 3, 0), market("drained", 5_000, 4_950)], NVDA);
    expect(out).toEqual([]);
  });

  it("hides a listed market with nothing to lend, and shows a small listed one that has some", () => {
    const out = selectBorrowMarkets([market("listed-empty", 0, 0, { listed: true }), market("listed-spcx", 13, 12, { listed: true }), market("listed-small", 600, 300, { listed: true })], NVDA);
    expect(ids(out)).toEqual(["listed-small"]);
    expect(out[0]?.thin).toBe(true);
  });

  it("does not call a deep market thin", () => {
    const [m] = selectBorrowMarkets([market("deep", 400_000, 100_000)], NVDA);
    expect(m?.thin).toBe(false);
  });

  it("orders by what lenders supplied, so the market people use leads", () => {
    const out = selectBorrowMarkets([market("small", 1_500, 1_000), market("big", 44_355, 39_956), market("mid", 21_707, 19_551)], NVDA);
    expect(ids(out)).toEqual(["big", "mid", "small"]);
  });

  it("keeps only markets for the stock asked about", () => {
    const out = selectBorrowMarkets([market("nvda", 28_843, 26_025), market("other", 28_843, 26_025, { collateral: OTHER })], NVDA);
    expect(ids(out)).toEqual(["nvda"]);
  });

  it("reports utilization from both sides of the market", () => {
    const [m] = selectBorrowMarkets([market("googl", 53_356, 48_020, { listed: true })], NVDA);
    expect(m?.utilization).toBeCloseTo(0.9, 2);
  });
});
