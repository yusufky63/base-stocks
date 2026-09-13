import { describe, expect, it } from "vitest";
import { kyberBuildResponseSchema, kyberRoutesResponseSchema } from "./schemas";
import { KYBER_ROUTER, kyberMinOut } from "./adapter";

/** Shaped like a live GET /routes answer for 10 USDC → NVDAc (fields the adapter reads, plus passthrough noise). */
const routes = {
  code: 0,
  message: "successfully",
  data: {
    routeSummary: {
      tokenIn: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      amountIn: "10000000",
      amountInUsd: "9.99",
      tokenOut: "0xb20000000000000000000078ee7ce2fe4908108c",
      amountOut: "5432100",
      amountOutUsd: "9.97",
      gas: "245000",
      gasPrice: "6000000",
      gasUsd: "0.0044",
      extraFee: { feeAmount: "25", chargeFeeBy: "currency_in", isInBps: true, feeReceiver: "0x1111111111111111111111111111111111111111" },
      route: [[{ pool: "0xabc", tokenIn: "0x8335", tokenOut: "0xb200", swapAmount: "10000000", amountOut: "5432100", exchange: "aerodrome", poolType: "aerodrome" }]],
      routeID: "r-1",
      checksum: "c",
      timestamp: 1_757_700_000,
    },
    routerAddress: KYBER_ROUTER,
  },
  requestId: "req-1",
};

describe("KyberSwap response schemas", () => {
  it("parses a route summary and keeps the router address", () => {
    const parsed = kyberRoutesResponseSchema.safeParse(routes);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.data?.routeSummary?.amountOut).toBe("5432100");
      expect(parsed.data.data?.routeSummary?.gas).toBe("245000");
      expect(parsed.data.data?.routerAddress).toBe(KYBER_ROUTER);
      expect(parsed.data.data?.routeSummary?.route?.[0]?.[0]?.exchange).toBe("aerodrome");
    }
  });

  it("accepts a no-route answer (non-zero code, null summary)", () => {
    const parsed = kyberRoutesResponseSchema.safeParse({ code: 4008, message: "route not found", data: null });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.data).toBeNull();
  });

  it("parses a build response and refuses calldata that is not hex", () => {
    const good = kyberBuildResponseSchema.safeParse({ code: 0, message: "successfully", data: { amountIn: "10000000", amountOut: "5430000", gas: "250000", gasUsd: "0.0045", data: "0xe21fd0e9", routerAddress: KYBER_ROUTER, transactionValue: "0" } });
    expect(good.success).toBe(true);
    const bad = kyberBuildResponseSchema.safeParse({ code: 0, data: { data: "not-calldata", routerAddress: KYBER_ROUTER } });
    expect(bad.success).toBe(false);
  });

  it("takes the minimum output from the build's amount, not the earlier route's", () => {
    // /routes said 5432100, the build re-priced to 5430000: the calldata holds the user to the latter less slippage.
    expect(kyberMinOut(5_430_000n, 100)).toBe(5_375_700n);
    expect(kyberMinOut(5_430_000n, 0)).toBe(5_430_000n);
  });
});
