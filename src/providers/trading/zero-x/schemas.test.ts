import { describe, expect, it } from "vitest";
import { zeroXPriceSchema, zeroXQuoteSchema } from "./schemas";

describe("0x v2 response schemas", () => {
  it("parses a liquidity-available price with allowance issue", () => {
    const parsed = zeroXPriceSchema.safeParse({
      liquidityAvailable: true,
      buyAmount: "4550596",
      sellAmount: "10000000",
      minBuyAmount: "4505090",
      allowanceTarget: "0x0000000000001fF3684f28c67538d4D072C22734",
      gas: 300000,
      gasPrice: "6000000",
      totalNetworkFee: "1800000000000",
      issues: { allowance: { actual: "0", spender: "0x0000000000001fF3684f28c67538d4D072C22734" }, balance: null, simulationIncomplete: false, invalidSourcesPassed: [] },
      route: { fills: [{ source: "Aerodrome_V2", proportionBps: "10000" }], tokens: [] },
      zid: "0xabc",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.gas).toBe("300000");
      expect(parsed.data.issues?.allowance?.spender).toMatch(/^0x/);
    }
  });

  it("parses a no-liquidity response with minimal fields", () => {
    expect(zeroXPriceSchema.safeParse({ liquidityAvailable: false, zid: "x" }).success).toBe(true);
  });

  it("requires a well-formed transaction object on quotes", () => {
    const bad = zeroXQuoteSchema.safeParse({ liquidityAvailable: true, transaction: { to: "not-an-address", data: "0x" } });
    expect(bad.success).toBe(false);
    const good = zeroXQuoteSchema.safeParse({ liquidityAvailable: true, transaction: { to: "0x0000000000001fF3684f28c67538d4D072C22734", data: "0x1234", gas: "1", gasPrice: "1", value: "0" } });
    expect(good.success).toBe(true);
  });
});
