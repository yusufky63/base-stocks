import { describe, expect, it } from "vitest";
import { ASK_AGAIN_AFTER_MS, classifyDismissal, isTradingSurface, shouldAsk } from "./eligibility-dismissal";

const T0 = 1_700_000_000_000;

describe("eligibility modal scheduling", () => {
  it("classifies a dismissal by age", () => {
    expect(classifyDismissal(null, T0)).toBe("never");
    expect(classifyDismissal(T0, T0 + 1000)).toBe("recent");
    expect(classifyDismissal(T0, T0 + ASK_AGAIN_AFTER_MS)).toBe("recent");
    expect(classifyDismissal(T0, T0 + ASK_AGAIN_AFTER_MS + 1)).toBe("stale");
  });

  it("asks on first arrival, wherever that is", () => {
    expect(shouldAsk("never", "/")).toBe(true);
    expect(shouldAsk("never", "/news")).toBe(true);
  });

  it("stays closed after a recent dismissal, even on trading surfaces", () => {
    expect(shouldAsk("recent", "/")).toBe(false);
    expect(shouldAsk("recent", "/markets")).toBe(false);
    expect(shouldAsk("recent", "/stocks/0xb2")).toBe(false);
  });

  it("asks again only on a trading surface once the dismissal is a day old", () => {
    expect(shouldAsk("stale", "/stocks/0xb2")).toBe(true);
    expect(shouldAsk("stale", "/build")).toBe(true);
    expect(shouldAsk("stale", "/how-it-works")).toBe(false);
    expect(shouldAsk("stale", "/")).toBe(false);
  });

  it("recognises trading surfaces by prefix, not by substring", () => {
    for (const p of ["/stocks", "/stocks/0xb2", "/build/tech", "/earn", "/gifts/claim/abc", "/pools/1", "/automate"]) expect(isTradingSurface(p)).toBe(true);
    for (const p of ["/", "/markets", "/news", "/stocksfoo", "/community", "/u/alice"]) expect(isTradingSurface(p)).toBe(false);
  });
});
