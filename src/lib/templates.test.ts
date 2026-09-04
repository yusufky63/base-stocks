import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { PortfolioTemplate } from "@/domain/portfolio";
import type { AssetsResponse } from "@/lib/client-api";
import { isStalled, partitionTemplates, templateLiveness } from "./templates";

const addr = (n: string) => `0xb200000000000000000000${n.padEnd(18, "0")}` as Address;
const NVDA = addr("a"), AAPL = addr("b"), CRCL = addr("c"), MSFT = addr("d");

/** Enough of the assets payload for the liveness rules; everything else is untouched by them. */
function assetsWith(rows: Array<{ address: Address; underlying: string; supply: string; liquidity: number }>): AssetsResponse {
  return {
    assets: rows.map((r) => ({ address: r.address, canonicalId: r.address.toLowerCase(), underlying: r.underlying, totalSupply: r.supply, status: "active" })),
    prices: Object.fromEntries(rows.map((r) => [r.address.toLowerCase(), { liquidityUsd: r.liquidity, volume24hUsd: null }])),
  } as unknown as AssetsResponse;
}

const ASSETS = assetsWith([
  { address: NVDA, underlying: "NVDA", supply: "1000000", liquidity: 2_100_000 }, // deep
  { address: AAPL, underlying: "AAPL", supply: "1000000", liquidity: 1_100_000 }, // deep
  { address: MSFT, underlying: "MSFT", supply: "1000000", liquidity: 9_979 }, //     issued, very thin
  { address: CRCL, underlying: "CRCL", supply: "0", liquidity: 0 }, //               never minted
]);

const tpl = (id: string, allocations: PortfolioTemplate["allocations"]): PortfolioTemplate => ({
  id,
  slug: id,
  name: id,
  description: "",
  active: true,
  allocations,
});

describe("template liveness", () => {
  /**
   * The distinction the copy used to blur: "waiting for issuance" was printed for a stock that had
   * been issued for months and simply had a shallow pool.
   */
  it("separates a stock with no supply from one with no depth", () => {
    const l = templateLiveness(tpl("t", [
      { assetAddress: NVDA, weightBps: 5000 },
      { assetAddress: MSFT, weightBps: 3000 },
      { assetAddress: CRCL, weightBps: 2000 },
    ]), ASSETS);

    expect(l.notIssued).toEqual(["CRCL"]);
    expect(l.illiquid).toEqual(["MSFT"]);
    expect(l.waiting).toEqual(["MSFT", "CRCL"]);
    expect(l.notIssuedBps).toBe(2000);
    expect(l.live).toBe(1);
    expect(l.total).toBe(3);
    expect(l.tradableBps).toBe(5000);
  });

  it("counts USDC as cash rather than as a stock leg", () => {
    const l = templateLiveness(tpl("t", [
      { assetAddress: NVDA, weightBps: 7000 },
      { assetAddress: "USDC", weightBps: 3000 },
    ]), ASSETS);
    expect(l.total).toBe(1);
    expect(l.cashBps).toBe(3000);
    expect(l.waiting).toEqual([]);
  });

  it("treats missing market data as unknown, not as a verdict", () => {
    const l = templateLiveness(tpl("t", [{ assetAddress: NVDA, weightBps: 10_000 }]), undefined);
    expect(l.live).toBe(0);
    expect(l.notIssued).toEqual(["0xb200"]); // no registry to name it with, so the address stands in
    expect(isStalled(tpl("t", [{ assetAddress: NVDA, weightBps: 10_000 }]), undefined)).toBe(false);
  });
});

describe("which templates belong on the shelf", () => {
  const core = tpl("core", [
    { assetAddress: NVDA, weightBps: 5000 },
    { assetAddress: AAPL, weightBps: 5000 },
  ]);
  const shallow = tpl("shallow", [
    { assetAddress: NVDA, weightBps: 8000 },
    { assetAddress: MSFT, weightBps: 2000 }, // issued, illiquid — a worse fill, not a dead leg
  ]);
  const crypto = tpl("crypto", [
    { assetAddress: NVDA, weightBps: 4000 },
    { assetAddress: CRCL, weightBps: 6000 }, // most of the money cannot move at all
  ]);
  const sliver = tpl("sliver", [
    { assetAddress: NVDA, weightBps: 9000 },
    { assetAddress: CRCL, weightBps: 1000 }, // 10% stuck: annoying, not disqualifying
  ]);

  it("stalls a template only on weight that cannot be bought at any price", () => {
    expect(isStalled(core, ASSETS)).toBe(false);
    expect(isStalled(shallow, ASSETS)).toBe(false);
    expect(isStalled(sliver, ASSETS)).toBe(false);
    expect(isStalled(crypto, ASSETS)).toBe(true);
  });

  it("puts the stalled ones on the second shelf, deepest first on the first", () => {
    const { ready, stalled } = partitionTemplates([crypto, shallow, core, sliver], ASSETS);
    expect(ready.map((t) => t.id)).toEqual(["core", "sliver", "shallow"]);
    expect(stalled.map((t) => t.id)).toEqual(["crypto"]);
  });

  /** The shelf is a rule, not a hand-edited list: minting the stock puts the template back. */
  it("returns a template to the shelf the moment its stock is minted", () => {
    const minted = assetsWith([
      { address: NVDA, underlying: "NVDA", supply: "1000000", liquidity: 2_100_000 },
      { address: CRCL, underlying: "CRCL", supply: "1000000", liquidity: 500_000 },
    ]);
    expect(isStalled(crypto, ASSETS)).toBe(true);
    expect(isStalled(crypto, minted)).toBe(false);
    expect(partitionTemplates([crypto], minted).ready.map((t) => t.id)).toEqual(["crypto"]);
  });
});
