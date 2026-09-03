import { describe, expect, it } from "vitest";
import { pickPrimaryPairs, type DexScreenerPair } from "./adapter";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function pair(base: string, quote: string, liquidity: number, pairAddress: string, chainId = "base"): DexScreenerPair {
  return { chainId, pairAddress, baseToken: { address: base }, quoteToken: { address: quote }, liquidity: { usd: liquidity }, priceUsd: "1" };
}

describe("pickPrimaryPairs", () => {
  it("picks the deepest pair where the token is the base asset and ignores other chains", () => {
    const best = pickPrimaryPairs(
      [pair(NVDA, USDC, 100, "0x1"), pair(NVDA, USDC, 5000, "0x2"), pair(USDC, NVDA, 99999, "0x3"), pair(NVDA, USDC, 1e9, "0x4", "ethereum")],
      [NVDA],
    );
    expect(best.get(NVDA.toLowerCase())?.pairAddress).toBe("0x2");
  });

  it("returns nothing for tokens without pairs", () => {
    expect(pickPrimaryPairs([], [NVDA]).size).toBe(0);
  });
});
