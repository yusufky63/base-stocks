import { describe, expect, it } from "vitest";
import { externalTarget } from "./miniapp-actions";

const HERE = "https://basestocks.finance/portfolio";

describe("which links a mini app host should open", () => {
  it("hands over links that leave the site", () => {
    expect(externalTarget("https://basescan.org/tx/0xabc", HERE)).toBe("https://basescan.org/tx/0xabc");
    expect(externalTarget("https://x.com/BaseOnStocks", HERE)).toBe("https://x.com/BaseOnStocks");
  });

  /** In-app navigation has to stay in the frame, or the app replaces itself with a copy of itself. */
  it("leaves in-app navigation alone, however it is written", () => {
    expect(externalTarget("/gifts", HERE)).toBeNull();
    expect(externalTarget("https://basestocks.finance/gifts", HERE)).toBeNull();
    expect(externalTarget("#top", HERE)).toBeNull();
    expect(externalTarget("?window=1W", HERE)).toBeNull();
  });

  /** A different port or scheme on the same host is a different origin, and dev runs on one. */
  it("treats a same-host different-origin link as external", () => {
    expect(externalTarget("http://localhost:4000/x", "http://localhost:3000/")).toBe("http://localhost:4000/x");
    expect(externalTarget("/x", "http://localhost:3000/")).toBeNull();
  });

  it("leaves schemes that are not the web to the host's own handling", () => {
    expect(externalTarget("mailto:hi@example.com", HERE)).toBeNull();
    expect(externalTarget("tel:+900", HERE)).toBeNull();
    expect(externalTarget("javascript:alert(1)", HERE)).toBeNull();
    expect(externalTarget("cbwallet://miniapp?url=x", HERE)).toBeNull();
  });

  it("does not throw on an href the browser cannot parse", () => {
    expect(externalTarget("", HERE)).toBeNull();
    expect(externalTarget("http://", HERE)).toBeNull();
  });
});
