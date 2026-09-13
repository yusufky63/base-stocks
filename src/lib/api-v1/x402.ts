import type { NextRequest, NextResponse } from "next/server";
import { withX402, x402ResourceServer, type RouteConfig } from "@x402/next";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { PRO_PRICE_USD } from "./catalog";

/**
 * Pay-per-call for the endpoints that cost real work to produce.
 *
 * The reads that answer "what is NVDA worth" stay free: they are cached, the CDN serves them, and
 * a price nobody can try is a price nobody uses. What is priced here is the opposite — a model
 * call, or a full multiplier-adjusted history — where every request has a cost that does not
 * disappear behind a cache.
 *
 * x402 turns that into an HTTP handshake: an unpaid request gets `402 Payment Required` with the
 * requirements (v2 carries them base64-encoded in the `PAYMENT-REQUIRED` header), the caller signs
 * a USDC authorization, retries with `PAYMENT-SIGNATURE`, and the facilitator settles. `withX402`
 * (rather than the proxy form) is used deliberately: it settles only after the handler answers
 * with a status below 400, so a failed request never costs the caller anything.
 *
 * Protocol v2 (`@x402/next`, `@x402/core`, `@x402/evm`): networks are CAIP-2 ids, the recipient
 * lives in each route's config, and the scheme (EIP-3009 `exact`) is registered on a resource
 * server that asks the facilitator once what it supports.
 */

/** Re-exported so the payment surface stays the one import a route or a test needs. */
export { PRO_PRICE_USD };

/** CAIP-2 ids of the two networks a deployment can price in. */
export const NETWORKS = { base: "eip155:8453", "base-sepolia": "eip155:84532" } as const;

/** Where payments land. Without it there is nothing to pay to, and the pro routes stay open. */
function payTo(): `0x${string}` | null {
  const a = process.env.X402_PAY_TO?.trim();
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : null;
}

/**
 * Base mainnet needs a production facilitator; the public one at x402.org is for testnets, so a
 * deployment without CDP credentials prices in Base Sepolia instead of pretending to take real
 * money. Adding `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` is what moves it to mainnet — no code
 * change, and no chance of a half-configured mainnet route.
 */
export function paymentNetwork(): "base" | "base-sepolia" {
  return process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET ? "base" : "base-sepolia";
}

export function x402Enabled(): boolean {
  return payTo() !== null;
}

/**
 * One resource server per process: it learns the facilitator's supported kinds once and every
 * wrapped route shares the answer. Built lazily so a deployment that never prices anything never
 * touches the facilitator.
 */
let server: Promise<x402ResourceServer> | null = null;

async function resourceServer(): Promise<x402ResourceServer> {
  if (server) return server;
  server = (async () => {
    // Mainnet goes through Coinbase's facilitator with CDP credentials; the default client points
    // at x402.org, which serves the testnets.
    const config = paymentNetwork() === "base" ? (await import("@coinbase/x402")).facilitator : undefined;
    const facilitator = new HTTPFacilitatorClient(config);
    return new x402ResourceServer(facilitator).register(NETWORKS[paymentNetwork()], new ExactEvmScheme());
  })();
  return server;
}

/** Tests: forget the shared server so a change of network or credentials is picked up. */
export function resetPaymentServer(): void {
  server = null;
}

/**
 * Wrap a route so it is paid when a recipient is configured, and plain when it is not.
 *
 * A deployment with no `X402_PAY_TO` (a preview, a fork, a local checkout) serves the same data
 * for free rather than returning a 402 nobody can satisfy.
 */
export async function withPayment(handler: (req: NextRequest) => Promise<NextResponse | Response>, description: string) {
  const to = payTo();
  if (!to) return handler;
  const config: RouteConfig = {
    accepts: { scheme: "exact", price: PRO_PRICE_USD, network: NETWORKS[paymentNetwork()], payTo: to },
    description,
    mimeType: "application/json",
  };
  // The wrapper asks the facilitator what it supports when the route module loads and, if that
  // call failed, again on the first paid request; a cold start never waits on it to serve.
  return withX402(handler as (req: NextRequest) => Promise<NextResponse>, config, await resourceServer());
}

/** What the docs page and `/api/v1` tell callers about the paid tier. */
export function paymentInfo() {
  return {
    enabled: x402Enabled(),
    scheme: "x402" as const,
    version: 2,
    price: PRO_PRICE_USD,
    asset: "USDC",
    network: paymentNetwork(),
    chain: NETWORKS[paymentNetwork()],
    payTo: payTo(),
    docs: "https://docs.base.org/build-on-base/accept-payments/charge-for-an-api",
  };
}
