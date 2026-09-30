import { beforeEach, describe, expect, it, vi } from "vitest";
import { Attribution } from "ox/erc8021";
import { decodeFunctionData, erc20Abi, type Address, type Hex } from "viem";

const mocks = vi.hoisted(() => ({ quote: vi.fn(), limit: vi.fn() }));

vi.mock("@/services/trade-router", () => ({ tradeRouter: { quote: mocks.quote } }));
vi.mock("@/services/b20-asset-service", () => ({
  getAssets: async () => [{ address: "0xb20000000000000000000078ee7ce2fe4908108c", canonicalId: "0xb20000000000000000000078ee7ce2fe4908108c", underlying: "NVDA", symbol: "NVDAc" }],
}));
vi.mock("@/lib/rate-limit", () => ({ enforceDurableRateLimit: mocks.limit }));

import { AppError } from "@/lib/errors";
import { publicEnv } from "@/config/public-env";
import { POST } from "./route";

const NVDA = "0xb20000000000000000000078ee7ce2fe4908108c" as Address;
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x6131b5fae19ea4f9d964eac0408e4408b66337b5" as Address;
const ROUTER_DATA = "0x12345678" as Hex;

function quote(over: Record<string, unknown> = {}) {
  return {
    provider: "kyber",
    side: "buy",
    assetAddress: NVDA,
    sellToken: USDC,
    buyToken: NVDA,
    sellAmount: "10000000",
    buyAmount: "50000000000000000",
    minBuyAmount: "49500000000000000",
    executablePriceUsd: 200,
    executablePricePerShareUsd: 200,
    priceImpactPct: 0.1,
    estimatedNetworkFeeUsd: 0.01,
    integratorFee: null,
    balanceInsufficient: false,
    allowanceRequired: true,
    allowanceSpender: SPENDER,
    warnings: [],
    transaction: { to: SPENDER, data: ROUTER_DATA, value: "0", gas: null, gasPrice: null },
    quoteId: "q1",
    expiresAt: 1_900_000_000_000,
    ...over,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://basestocks.finance/api/v1/trade", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

const valid = { stock: "NVDA", side: "buy", amount: "10000000", account: ACCOUNT };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.limit.mockResolvedValue(undefined);
  mocks.quote.mockResolvedValue(quote());
});

describe("POST /api/v1/trade", () => {
  it("approves exactly the amount for the route's spender, then sends the route's own transaction", async () => {
    const res = await POST(post(valid));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const { data } = await res.json();
    expect(data.calls.map((c: { description: string }) => c.description)).toEqual(["approve", "trade"]);
    const suffix = Attribution.toDataSuffix({ codes: [publicEnv.builderCode] });
    const approve = data.calls[0];
    expect(approve.to).toBe(USDC);
    expect(approve.data.endsWith(suffix.slice(2))).toBe(true);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approve.data.slice(0, approve.data.length - (suffix.length - 2)) as Hex });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args).toEqual([expect.stringMatching(new RegExp(SPENDER, "i")), 10_000_000n]);
    expect(data.calls[1]).toEqual({ to: SPENDER, data: `${ROUTER_DATA}${suffix.slice(2)}`, value: "0", description: "trade" });
    expect(data.approval).toEqual({ token: USDC, spender: SPENDER, amount: "10000000" });
    expect(data.stock).toEqual({ symbol: "NVDA", tokenSymbol: "NVDAc", address: NVDA });
  });

  it("asks the app's router for a transaction route, never a signed order", async () => {
    await POST(post({ ...valid, slippageBps: 200, provider: "uniswap" }));
    expect(mocks.quote).toHaveBeenCalledWith(
      expect.objectContaining({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n, taker: ACCOUNT, slippageBps: 200, provider: "uniswap", orders: false, noZeroX: false }),
    );
  });

  it("needs no approval when paying with ETH, and carries a partner's builder code beside the app's", async () => {
    mocks.quote.mockResolvedValue(quote({ sellToken: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", transaction: { to: SPENDER, data: ROUTER_DATA, value: "5000000000000000", gas: null, gasPrice: null } }));
    const res = await POST(post({ ...valid, payWith: "ETH", amount: "5000000000000000", builderCode: "bc_partner1" }));
    const { data } = await res.json();
    expect(data.approval).toBeNull();
    expect(data.calls).toHaveLength(1);
    expect(data.calls[0].value).toBe("5000000000000000");
    expect(data.calls[0].data).toBe(`${ROUTER_DATA}${Attribution.toDataSuffix({ codes: [publicEnv.builderCode, "bc_partner1"] }).slice(2)}`);
  });

  it("skips 0x for a US visitor who confirmed eligibility, as the app's own quote route does", async () => {
    await POST(post(valid, { "x-vercel-ip-country": "US", "x-bstocks-eligibility": "confirmed" }));
    expect(mocks.quote).toHaveBeenCalledWith(expect.objectContaining({ noZeroX: true }));
  });

  it("refuses a US visitor who has not confirmed, before any provider is asked", async () => {
    const res = await POST(post(valid, { "x-vercel-ip-country": "US" }));
    expect(res.status).toBe(451);
    expect(mocks.quote).not.toHaveBeenCalled();
  });

  it("refuses a body it cannot trust", async () => {
    for (const bad of [
      { ...valid, account: "nope" },
      { ...valid, side: "hold" },
      { ...valid, amount: "0" },
      { ...valid, slippageBps: 900 },
      { ...valid, provider: "cow" },
      { ...valid, builderCode: "has,comma" },
    ]) {
      const res = await POST(post(bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await res.json()).error.code).toBe("BAD_BODY");
    }
    expect(mocks.quote).not.toHaveBeenCalled();
  });

  it("names an unknown stock, a missing route, a router refusal and a limit", async () => {
    expect((await POST(post({ ...valid, stock: "ZZZZ" }))).status).toBe(404);
    mocks.quote.mockResolvedValueOnce(quote({ transaction: null }));
    expect((await (await POST(post(valid))).json()).error.code).toBe("NO_ROUTE");
    mocks.quote.mockRejectedValueOnce(new AppError("ASSET_NOT_VERIFIED", "Not verified.", 403));
    const refused = await POST(post(valid));
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("ASSET_NOT_VERIFIED");
    mocks.limit.mockRejectedValueOnce(new AppError("RATE_LIMITED", "Too many requests. Please slow down.", 429));
    expect((await POST(post(valid))).status).toBe(429);
  });
});
