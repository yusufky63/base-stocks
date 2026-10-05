import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";

const h = vi.hoisted(() => ({ fetchJson: vi.fn() }));
vi.mock("@/lib/http", () => ({
  fetchJson: h.fetchJson,
  metrics: { count: () => undefined },
  CircuitBreaker: class {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    }
  },
}));

import { getDexScreenerMarkets } from "./adapter";

const CAKE = "0xb200000000000000000000f215e4c890cfb7176b" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const pair = (pairAddress: string, liquidity: number, priceUsd: string) => ({ chainId: "base", dexId: "x", pairAddress, baseToken: { address: CAKE }, quoteToken: { address: USDC }, liquidity: { usd: liquidity }, priceUsd, volume: { h24: 10 }, priceChange: { h24: 1 } });

describe("getDexScreenerMarkets", () => {
  beforeEach(() => h.fetchJson.mockReset());

  /**
   * CAKEc, 2026-10-06. The batch endpoint answered with the $141 Uniswap pool at $882 and the stock
   * was shown at eight times its $109.65 share price, while a $1,941 Aerodrome pool priced it at
   * $105.73. The full list had both.
   */
  it("prices a token from its deepest pool when the batch endpoint returned a shallower one", async () => {
    const shallow = pair("0xshallow", 141, "882.21");
    const deep = pair("0xdeep", 1_941, "105.73");
    h.fetchJson.mockImplementation(async (...args: unknown[]) => (String(args[0]).includes("/tokens/v1/") ? { status: 200, data: [shallow] } : { status: 200, data: { pairs: [shallow, deep] } }));
    const m = (await getDexScreenerMarkets([CAKE])).get(CAKE);
    expect(m?.priceUsd).toBe(105.73);
    expect(m?.primaryPool).toBe("0xdeep");
    expect(m?.liquidityUsd).toBe(2_082);
  });

  it("keeps the batch pair's price when the full list cannot be read", async () => {
    h.fetchJson.mockImplementation(async (...args: unknown[]) => (String(args[0]).includes("/tokens/v1/") ? { status: 200, data: [pair("0xshallow", 141, "882.21")] } : { status: 500, data: null }));
    const m = (await getDexScreenerMarkets([CAKE])).get(CAKE);
    expect(m?.priceUsd).toBe(882.21);
    expect(m?.primaryPool).toBe("0xshallow");
  });
});
