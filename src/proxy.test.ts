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

  it("opens once the visitor has confirmed eligibility", () => {
    expect(blocked("/api/pools", { ...US, method: "POST", attested: true })).toBe(false);
    expect(blocked("/api/gifts", { ...US, method: "POST", attested: true })).toBe(false);
    expect(blocked("/api/trade/quote", { ...US, method: "POST", attested: true })).toBe(false);
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
