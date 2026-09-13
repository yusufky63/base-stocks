import { describe, expect, it } from "vitest";
import { zeroAddress, type Address } from "viem";
import { NATIVE_ETH, USDC_ADDRESS } from "@/config/chain";
import { uniswapApprovalResponseSchema, uniswapQuoteResponseSchema, uniswapSwapResponseSchema } from "./schemas";
import { UNISWAP_SWAP_PROXY, uniswapTokenAddress } from "./adapter";

/** Shaped like a live POST /quote answer in the no-Permit2 (proxy approval) flow. */
const quote = {
  requestId: "3f1e",
  routing: "CLASSIC",
  permitData: null,
  isTokenApprovalApplicable: true,
  quote: {
    chainId: 8453,
    swapper: "0x1111111111111111111111111111111111111111",
    input: { amount: "10000000", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    output: { amount: "5400000", token: "0xb20000000000000000000078ee7ce2fE4908108C", recipient: "0x1111111111111111111111111111111111111111", minimumAmount: "5346000" },
    slippage: 1,
    tradeType: "EXACT_INPUT",
    gasFee: "1200000000000",
    gasFeeUSD: "0.0036",
    gasUseEstimate: "180000",
    priceImpact: 0.12,
    quoteId: "q-9",
    routeString: "[V3] 100.00% = USDC -- 0.3% [0xpool] --> NVDAc",
    route: [[{ type: "v3-pool", address: "0xpool", tokenIn: { address: "0x8335" }, tokenOut: { address: "0xb200" }, fee: "3000", amountIn: "10000000", amountOut: "5400000" }]],
  },
};

describe("Uniswap Trading API response schemas", () => {
  it("parses a classic quote with its gas figures and route", () => {
    const parsed = uniswapQuoteResponseSchema.safeParse(quote);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.quote.output.amount).toBe("5400000");
      expect(parsed.data.quote.output.minimumAmount).toBe("5346000");
      expect(parsed.data.quote.gasUseEstimate).toBe("180000");
      expect(parsed.data.quote.route?.[0]?.[0]?.fee).toBe("3000");
    }
  });

  it("requires the routing and the quote amounts", () => {
    expect(uniswapQuoteResponseSchema.safeParse({ quote: { input: { amount: "1" }, output: { amount: "1" } } }).success).toBe(false);
    expect(uniswapQuoteResponseSchema.safeParse({ routing: "CLASSIC", quote: { input: { amount: "1" } } }).success).toBe(false);
  });

  it("parses a swap and an approval, and refuses calldata that is not hex", () => {
    const swap = uniswapSwapResponseSchema.safeParse({ requestId: "s", swap: { to: UNISWAP_SWAP_PROXY, from: "0x1111111111111111111111111111111111111111", data: "0x24856bc3", value: "0x0", gasLimit: "220000", chainId: 8453, maxFeePerGas: "12000000" } });
    expect(swap.success).toBe(true);
    expect(uniswapSwapResponseSchema.safeParse({ swap: { to: UNISWAP_SWAP_PROXY, data: "nope" } }).success).toBe(false);
    const approval = uniswapApprovalResponseSchema.safeParse({ requestId: "a", approval: { to: USDC_ADDRESS, data: "0x095ea7b3", value: "0x0", chainId: 8453 } });
    expect(approval.success).toBe(true);
    expect(uniswapApprovalResponseSchema.safeParse({ approval: null }).success).toBe(true);
  });

  /**
   * Every other route spells native ETH as 0xeeee…; the Uniswap Trading API says "To swap native
   * tokens, use the address 0x0000000000000000000000000000000000000000". Sending the 0xeeee form
   * asked it about an ERC-20 it had never heard of.
   */
  it("spells native ETH the way the API does and leaves ERC-20s alone", () => {
    expect(uniswapTokenAddress(NATIVE_ETH)).toBe(zeroAddress);
    expect(uniswapTokenAddress(NATIVE_ETH.toUpperCase().replace("0X", "0x") as Address)).toBe(zeroAddress);
    expect(uniswapTokenAddress(USDC_ADDRESS)).toBe(USDC_ADDRESS);
  });
});
