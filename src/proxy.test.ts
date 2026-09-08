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

  /**
   * The default mode asks, it does not ban. A 451 a checkbox clears must not be worded like a wall,
   * or the copy tells a visitor the opposite of what the product does.
   */
  it("refuses outright by default, with no box to tick", async () => {
    const res = proxy(request("/api/pools", { ...US, method: "POST" }));
    expect(res.status).toBe(451);
    const body = (await res.json()) as { error: { code: string; message: string; details: { mode: string } } };
    expect(body.error.code).toBe("REGION_RESTRICTED");
    expect(body.error.details.mode).toBe("block");
    expect(body.error.message).toMatch(/not available in your region/i);
  });

  it("does not open on an attestation cookie while the mode is block", () => {
    // Self-certification is a real mechanism, but it has to be asked for: a checkbox that unlocks
    // trading for a blocked region is enabling trading for that region, however it is worded.
    expect(blocked("/api/pools", { ...US, method: "POST", attested: true })).toBe(true);
    expect(blocked("/api/trade/quote", { ...US, method: "POST", attested: true })).toBe(true);
  });

  it("opens on an attestation only where the deployment asked for attest mode", async () => {
    const prev = process.env.GEOBLOCK_MODE;
    process.env.GEOBLOCK_MODE = "attest";
    try {
      expect(blocked("/api/trade/quote", { ...US, method: "POST", attested: true })).toBe(false);
      const res = proxy(request("/api/pools", { ...US, method: "POST" }));
      const body = (await res.json()) as { error: { message: string; details: { mode: string } } };
      expect(body.error.details.mode).toBe("attest");
      expect(body.error.message).toMatch(/confirm your eligibility/i);
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
