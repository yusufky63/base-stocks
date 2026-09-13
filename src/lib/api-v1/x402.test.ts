import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";

/**
 * The payment path, exercised without a server or a wallet.
 *
 * A paid route that only gets tried in a demo is a paid route nobody has tested, so these check
 * the two states that matter: no recipient configured (the data stays free rather than answering
 * a 402 nobody can satisfy) and a recipient configured (an unpaid request is turned away with the
 * requirements attached).
 */
const PAY_TO = "0x1111111111111111111111111111111111111111";
const original = { payTo: process.env.X402_PAY_TO, id: process.env.CDP_API_KEY_ID, secret: process.env.CDP_API_KEY_SECRET };

/**
 * Warm the module graph once. The x402 packages take seconds to load from a cold cache — enough
 * to spend a whole 5 s test budget on an import, which is how this passed locally and failed in CI.
 */
beforeAll(async () => {
  await import("./x402");
}, 60_000);

afterEach(async () => {
  process.env.X402_PAY_TO = original.payTo;
  process.env.CDP_API_KEY_ID = original.id;
  process.env.CDP_API_KEY_SECRET = original.secret;
  (await import("./x402")).resetPaymentServer();
});

function request(url = "https://basestocks.finance/api/v1/pro/report"): NextRequest {
  const req = new Request(url, { method: "GET", headers: { accept: "application/json" } }) as unknown as NextRequest;
  // The Next adapter reads `nextUrl.pathname`; a plain Request has no such field.
  Object.defineProperty(req, "nextUrl", { value: new URL(url), configurable: true });
  return req;
}

const ok = async () => new Response(JSON.stringify({ hello: "world" }), { status: 200, headers: { "content-type": "application/json" } });

/**
 * Building the 402 asks the facilitator which payment kinds it supports, which is a live HTTP
 * call. The test stubs it so the assertion is about our configuration rather than about whether
 * a third party's testnet service answered this minute.
 */
function stubFacilitator() {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/supported")) {
      return new Response(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/** v2 carries the requirements base64-encoded in a header rather than in the body. */
function decodeRequired(res: Response): { x402Version: number; accepts: Array<{ payTo?: string; network?: string; amount?: string; scheme?: string }> } {
  const header = res.headers.get("payment-required");
  expect(header).toBeTruthy();
  return JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
}

describe("x402 payment wiring", () => {
  it("serves the data free when no recipient is configured", async () => {
    delete process.env.X402_PAY_TO;
    const { withPayment, x402Enabled } = await import("./x402");
    expect(x402Enabled()).toBe(false);
    const handler = await withPayment(ok, "test");
    const res = await handler(request());
    expect(res.status).toBe(200);
  });

  it("prices in Base Sepolia until CDP credentials make mainnet real", async () => {
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
    const { paymentNetwork, paymentInfo } = await import("./x402");
    expect(paymentNetwork()).toBe("base-sepolia");
    expect(paymentInfo().chain).toBe("eip155:84532");
    process.env.CDP_API_KEY_ID = "id";
    process.env.CDP_API_KEY_SECRET = "secret";
    expect(paymentNetwork()).toBe("base");
    expect(paymentInfo().chain).toBe("eip155:8453");
  });

  it("turns an unpaid request away with the requirements once a recipient exists", async () => {
    process.env.X402_PAY_TO = PAY_TO;
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
    const { withPayment, PRO_PRICE_USD, resetPaymentServer } = await import("./x402");
    resetPaymentServer();
    expect(PRO_PRICE_USD).toBe("$0.10");
    const restore = stubFacilitator();
    try {
      const handler = await withPayment(ok, "test");
      const res = await handler(request());
      expect(res.status).toBe(402);
      const required = decodeRequired(res);
      expect(required.x402Version).toBe(2);
      const accepts = required.accepts[0];
      expect(accepts?.scheme).toBe("exact");
      expect(accepts?.payTo?.toLowerCase()).toBe(PAY_TO);
      expect(accepts?.network).toBe("eip155:84532");
      // Ten cents of a six-decimal token.
      expect(accepts?.amount).toBe("100000");
    } finally {
      restore();
    }
  }, 20_000);
});
