import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { veloraPricesSchema, veloraTxSchema } from "./schemas";
import { VELORA_AUGUSTUS_V6_2, normalizeVeloraRoute } from "./adapter";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;

/** Shaped like a live GET /prices answer (v6.2) for 10 USDC → NVDAc. */
const prices = {
  priceRoute: {
    blockNumber: 36_000_000,
    network: 8453,
    srcToken: USDC.toLowerCase(),
    srcDecimals: 6,
    srcAmount: "10000000",
    destToken: NVDA.toLowerCase(),
    destDecimals: 8,
    destAmount: "5410000",
    bestRoute: [{ percent: 100, swaps: [{ srcToken: USDC.toLowerCase(), destToken: NVDA.toLowerCase(), swapExchanges: [{ exchange: "UniswapV3", srcAmount: "10000000", destAmount: "5410000", percent: 100, poolAddresses: ["0xpool"] }] }] }],
    gasCostUSD: "0.0031",
    gasCost: "190000",
    side: "SELL",
    version: "6.2",
    contractAddress: VELORA_AUGUSTUS_V6_2,
    tokenTransferProxy: VELORA_AUGUSTUS_V6_2,
    contractMethod: "swapExactAmountInOnUniswapV3",
    partnerFee: 0,
    srcUSD: "10.00",
    destUSD: "9.98",
    partner: "bstocks",
    maxImpactReached: false,
    hmac: "abc",
  },
};

const intent = { chainId: 8453, side: "buy" as const, assetAddress: NVDA, sellToken: USDC, buyToken: NVDA, sellAmount: 10_000_000n, sellTokenDecimals: 6, buyTokenDecimals: 8, slippageBps: 100 };

describe("Velora response schemas", () => {
  it("parses a price route and normalizes it with Augustus as the spender", () => {
    const parsed = veloraPricesSchema.safeParse(prices);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const q = normalizeVeloraRoute(parsed.data.priceRoute!, intent);
    expect(q.buyAmount).toBe(5_410_000n);
    expect(q.minBuyAmount).toBe(5_355_900n); // 1% slippage
    expect(q.gas).toBe(190_000n);
    expect(q.totalNetworkFeeWei).toBeNull(); // Velora prices gas in USD only; the router estimates the fee
    expect(q.allowanceTarget).toBe(VELORA_AUGUSTUS_V6_2);
    expect(q.route).toEqual([{ source: "UniswapV3", proportionBps: 10_000 }]);
  });

  it("parses an error answer without a route", () => {
    const parsed = veloraPricesSchema.safeParse({ error: "No routes found with enough liquidity" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.priceRoute).toBeUndefined();
  });

  it("parses a built transaction and refuses calldata that is not hex", () => {
    const good = veloraTxSchema.safeParse({ from: "0xabc", to: VELORA_AUGUSTUS_V6_2, value: "0", data: "0xe3ead59e", gasPrice: "6000000", gas: "210000", chainId: 8453 });
    expect(good.success).toBe(true);
    expect(veloraTxSchema.safeParse({ to: VELORA_AUGUSTUS_V6_2, data: "garbage" }).success).toBe(false);
    const err = veloraTxSchema.safeParse({ to: "", data: "0x", error: "Insufficient allowance" });
    expect(err.success && err.data.error).toBe("Insufficient allowance");
  });
});
