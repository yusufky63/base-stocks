import { describe, expect, it } from "vitest";
import { pickPrimaryPairs, type DexScreenerPair } from "./adapter";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const TSLA = "0xb2000000000000000000001e800a7f5189430cD0";
/** A long-tail token. Whatever it is worth, it is not what a stock is worth. */
const STC = "0x1111111111111111111111111111111111111111";

function pair(base: string, quote: string, liquidity: number, pairAddress: string, chainId = "base", priceUsd = "1"): DexScreenerPair {
  return { chainId, pairAddress, baseToken: { address: base }, quoteToken: { address: quote }, liquidity: { usd: liquidity }, priceUsd };
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

  /**
   * The TSLAc case, 2026-09-10.
   *
   * The upstream returned one pair for TSLAc, quoted in a long-tail token, and reported the stock at
   * $17,936 against a Chainlink reference of $366. It was displayed for a day, marked Live, and it
   * multiplied every TSLAc holder's portfolio by 49.
   *
   * A pool prices a token against whatever is on the other side, so a pair quoted in something whose
   * own dollar price is nonsense reports nonsense. Depth does not change that: the pair held
   * $275,120.
   */
  it("refuses a pair quoted in a long-tail token, whatever its depth", () => {
    const best = pickPrimaryPairs(
      [
        pair(TSLA, STC, 275_120, "0xstc", "base", "17936.63"),
        pair(TSLA, USDC, 709_888, "0xaero", "base", "365.73"),
      ],
      [TSLA],
    );
    expect(best.get(TSLA.toLowerCase())?.pairAddress).toBe("0xaero");
    expect(best.get(TSLA.toLowerCase())?.priceUsd).toBe("365.73");
  });

  it("would rather price nothing than price against a token it cannot reach dollars through", () => {
    // Falling through to no market price is not a failure here: the reference takes over, and the
    // reference is the number a pool cannot move.
    const best = pickPrimaryPairs([pair(TSLA, STC, 1_000_000, "0xstc", "base", "17936.63")], [TSLA]);
    expect(best.size).toBe(0);
  });

  it("accepts the majors a router can actually reach dollars through", () => {
    for (const quote of [USDC, WETH]) {
      expect(pickPrimaryPairs([pair(NVDA, quote, 50_000, "0xok")], [NVDA]).size).toBe(1);
    }
  });
});
