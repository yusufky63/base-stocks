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
 * Warm the module graph once. `x402-next` is inlined for this suite and takes seconds to load from
 * a cold cache — enough to spend a whole 5 s test budget on an import, which is how this passed
 * locally and failed in CI.
 */
beforeAll(async () => {
  await import("./x402");
}, 60_000);

afterEach(() => {
  process.env.X402_PAY_TO = original.payTo;
  process.env.CDP_API_KEY_ID = original.id;
  process.env.CDP_API_KEY_SECRET = original.secret;
  delete process.env.X402_PAY_TO_UNSET;
});

function request(url = "https://basestocks.finance/api/v1/pro/report"): NextRequest {
  const req = new Request(url, { method: "GET" }) as unknown as NextRequest;
  // x402-next reads `nextUrl.pathname`; a plain Request has no such field.
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
      return new Response(JSON.stringify({ kinds: [{ x402Version: 1, scheme: "exact", network: "base-sepolia" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
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
    const { paymentNetwork } = await import("./x402");
    expect(paymentNetwork()).toBe("base-sepolia");
    process.env.CDP_API_KEY_ID = "id";
    process.env.CDP_API_KEY_SECRET = "secret";
    expect(paymentNetwork()).toBe("base");
  });

  it("turns an unpaid request away with the requirements once a recipient exists", async () => {
    process.env.X402_PAY_TO = PAY_TO;
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
    const { withPayment, PRO_PRICE_USD } = await import("./x402");
    expect(PRO_PRICE_USD).toBe("$0.10");
    const restore = stubFacilitator();
    const handler = await withPayment(ok, "test");
    const res = await handler(request()).finally(restore);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts?: Array<{ payTo?: string; network?: string; maxAmountRequired?: string }> };
    const accepts = body.accepts?.[0];
    expect(accepts?.payTo?.toLowerCase()).toBe(PAY_TO);
    expect(accepts?.network).toBe("base-sepolia");
    // Ten cents of a six-decimal token.
    expect(accepts?.maxAmountRequired).toBe("100000");
  });
});
