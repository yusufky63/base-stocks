import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

function request(path: string, opts: { method?: string; country?: string; attested?: boolean } = {}) {
  const headers = new Headers();
  if (opts.country) headers.set("x-vercel-ip-country", opts.country);
  if (opts.attested) headers.set("cookie", "bstocks_eligibility=confirmed");
  return new NextRequest(new URL(`https://basestocks.finance${path}`), { method: opts.method ?? "GET", headers });
}

const blocked = (path: string, opts: Parameters<typeof request>[1] = {}) => proxy(request(path, opts)).status === 451;

/**
 * Coinbase Tokenized Stocks are for eligible persons outside the United States, and the geoblock is
 * the one rule in this app that a refactor must never quietly loosen. A comment cannot hold that;
 * these can.
 */
describe("compliance geoblock", () => {
  const US = { country: "US" } as const;

  it("closes execution to a blocked region", () => {
    expect(blocked("/api/trade/quote", { ...US, method: "POST" })).toBe(true);
    expect(blocked("/api/trade/price", { ...US, method: "POST" })).toBe(true);
    expect(blocked("/api/earn/prepare", { ...US, method: "POST" })).toBe(true);
    expect(blocked("/api/portfolio/plan", { ...US, method: "POST" })).toBe(true);
    expect(blocked("/api/portfolio/intent", { ...US, method: "POST" })).toBe(true);
    expect(blocked("/api/automation/prepare-run", { ...US, method: "POST" })).toBe(true);
  });

  /** Giving a tokenized stock away, or signing a ticket that lets someone take one, is distribution. */
  it("closes gifts and gift pools to a blocked region", () => {
    expect(blocked("/api/gifts", { ...US, method: "POST" })).toBe(true);
    expect(blocked("/api/gifts/gift_abc", { ...US, method: "PATCH" })).toBe(true);
    expect(blocked("/api/pools", { ...US, method: "POST" })).toBe(true);
    expect(blocked("/api/pools/pool_abc", { ...US, method: "PATCH" })).toBe(true);
    expect(blocked("/api/pools/pool_abc/ticket", { ...US, method: "POST" })).toBe(true);
    expect(blocked("/api/pools/pool_abc/attest", { ...US, method: "POST" })).toBe(true);
    expect(blocked("/api/pools/pool_abc/claims", { ...US, method: "POST" })).toBe(true);
  });

  /** Browsing stays open everywhere — that is the deliberate half of the policy. */
  it("leaves reading open to a blocked region", () => {
    expect(blocked("/api/pools", US)).toBe(false);
    expect(blocked("/api/pools/pool_abc", US)).toBe(false);
    expect(blocked("/api/pools/pool_abc/ticket", US)).toBe(false); // the quest checklist is a read
    expect(blocked("/api/gifts?owner=0x0", US)).toBe(false);
    expect(blocked("/api/assets", US)).toBe(false);
    expect(blocked("/api/market/0x0", US)).toBe(false);
    expect(blocked("/api/news", US)).toBe(false);
    expect(blocked("/markets", US)).toBe(false);
    expect(blocked("/pools/pool_abc", US)).toBe(false);
  });

  /**
   * The default mode asks, it does not ban. A 451 a checkbox clears must not be worded like a wall,
   * or the copy tells a visitor the opposite of what the product does.
   */
  it("asks a blocked region to confirm eligibility by default", async () => {
    const res = proxy(request("/api/pools", { ...US, method: "POST" }));
    expect(res.status).toBe(451);
    const body = (await res.json()) as { error: { code: string; message: string; details: { mode: string } } };
    expect(body.error.code).toBe("REGION_RESTRICTED");
    expect(body.error.details.mode).toBe("attest");
    expect(body.error.message).toMatch(/confirm your eligibility/i);
  });

  /** A US IP is where the connection comes from; the visitor's own statement decides. */
  it("opens execution to a visitor who confirmed they are not a US person, even from a US IP", () => {
    expect(blocked("/api/trade/quote", { ...US, method: "POST", attested: true })).toBe(false);
    expect(blocked("/api/earn/prepare", { ...US, method: "POST", attested: true })).toBe(false);
    expect(blocked("/api/pools", { ...US, method: "POST", attested: true })).toBe(false);
  });

  it("refuses outright, cookie or not, where the deployment asked for block mode", async () => {
    const prev = process.env.GEOBLOCK_MODE;
    process.env.GEOBLOCK_MODE = "block";
    try {
      expect(blocked("/api/pools", { ...US, method: "POST", attested: true })).toBe(true);
      expect(blocked("/api/trade/quote", { ...US, method: "POST", attested: true })).toBe(true);
      const res = proxy(request("/api/pools", { ...US, method: "POST" }));
      const body = (await res.json()) as { error: { message: string; details: { mode: string } } };
      expect(body.error.details.mode).toBe("block");
      expect(body.error.message).toMatch(/not available in your region/i);
    } finally {
      if (prev === undefined) delete process.env.GEOBLOCK_MODE;
      else process.env.GEOBLOCK_MODE = prev;
    }
  });

  /**
   * The same answer as a header, for a widget in another site's frame whose browser refused the
   * cookie (Safari). It is the visitor's own statement either way, and block mode ignores both.
   */
  it("takes the answer as a header when the frame could not keep the cookie", () => {
    const withHeader = (path: string, value: string) => {
      const headers = new Headers({ "x-vercel-ip-country": "US", "x-bstocks-eligibility": value });
      return proxy(new NextRequest(new URL(`https://basestocks.finance${path}`), { method: "POST", headers })).status === 451;
    };
    expect(withHeader("/api/trade/quote", "confirmed")).toBe(false);
    expect(withHeader("/api/trade/price", "confirmed")).toBe(false);
    expect(withHeader("/api/trade/quote", "yes")).toBe(true);
    const prev = process.env.GEOBLOCK_MODE;
    process.env.GEOBLOCK_MODE = "block";
    try {
      expect(withHeader("/api/trade/quote", "confirmed")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GEOBLOCK_MODE;
      else process.env.GEOBLOCK_MODE = prev;
    }
  });

  it("never blocks a region that is not on the list", () => {
    for (const country of ["TR", "DE", "GB", "JP"]) {
      expect(blocked("/api/pools", { country, method: "POST" })).toBe(false);
      expect(blocked("/api/trade/quote", { country, method: "POST" })).toBe(false);
    }
  });

  /** No country header means no guess: an unknown origin is not treated as blocked. */
  it("does not guess when the host reports no country", () => {
    expect(blocked("/api/pools", { method: "POST" })).toBe(false);
    expect(blocked("/api/trade/quote", { method: "POST" })).toBe(false);
  });
});

/** The public trade builder is an execution route, and it is called from other sites' browsers. */
describe("public trade builder", () => {
  const US = { country: "US" } as const;

  it("is closed to a blocked region until the visitor confirms, like the app's own quotes", () => {
    expect(blocked("/api/v1/trade", { ...US, method: "POST" })).toBe(true);
    expect(blocked("/api/v1/trade", { ...US, method: "POST", attested: true })).toBe(false);
    expect(blocked("/api/v1/trade", { country: "DE", method: "POST" })).toBe(false);
  });

  it("lets the preflight through, so a caller on another site can read the refusal", () => {
    expect(blocked("/api/v1/trade", { ...US, method: "OPTIONS" })).toBe(false);
    const refused = proxy(request("/api/v1/trade", { ...US, method: "POST" }));
    expect(refused.headers.get("access-control-allow-origin")).toBe("*");
    // The app's own routes stay same-origin: their refusal carries no CORS header.
    expect(proxy(request("/api/trade/quote", { ...US, method: "POST" })).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("leaves the read endpoints open everywhere", () => {
    for (const path of ["/api/v1/stocks", "/api/v1/stocks/NVDA", "/api/v1/portfolio/0x1111111111111111111111111111111111111111", "/api/v1/news"]) expect(blocked(path, US), path).toBe(false);
  });
});
