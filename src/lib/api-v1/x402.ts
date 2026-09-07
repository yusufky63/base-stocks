import type { NextRequest, NextResponse } from "next/server";
import { withX402, type RouteConfig } from "x402-next";
import { PRO_PRICE_USD } from "./catalog";

/** `x402` is a transitive dependency, so the facilitator's shape comes from the function that takes it. */
type FacilitatorConfig = NonNullable<Parameters<typeof withX402>[3]>;

/**
 * Pay-per-call for the endpoints that cost real work to produce.
 *
 * The reads that answer "what is NVDA worth" stay free: they are cached, the CDN serves them, and
 * a price nobody can try is a price nobody uses. What is priced here is the opposite — a model
 * call, or a full multiplier-adjusted history — where every request has a cost that does not
 * disappear behind a cache.
 *
 * x402 turns that into an HTTP handshake: an unpaid request gets `402 Payment Required` with the
 * amount and the recipient, the caller signs a USDC authorization, retries, and the facilitator
 * settles. `withX402` (rather than the middleware form) is used deliberately: it settles only
 * after the handler succeeds, so a failed request never costs the caller anything.
 */

/** Re-exported so the payment surface stays the one import a route or a test needs. */
export { PRO_PRICE_USD };

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

async function facilitator(): Promise<FacilitatorConfig | undefined> {
  if (paymentNetwork() !== "base") return undefined; // x402-next defaults to the x402.org testnet facilitator
  const { facilitator: cdp } = await import("@coinbase/x402");
  return cdp as FacilitatorConfig;
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
    price: PRO_PRICE_USD,
    network: paymentNetwork(),
    config: { description, mimeType: "application/json" },
  };
  return withX402(handler as (req: NextRequest) => Promise<NextResponse>, to, config, await facilitator());
}

/** What the docs page and `/api/v1` tell callers about the paid tier. */
export function paymentInfo() {
  return {
    enabled: x402Enabled(),
    scheme: "x402" as const,
    price: PRO_PRICE_USD,
    asset: "USDC",
    network: paymentNetwork(),
    payTo: payTo(),
    docs: "https://docs.base.org/build-on-base/accept-payments/charge-for-an-api",
  };
}
