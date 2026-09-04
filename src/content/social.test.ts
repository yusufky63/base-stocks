import { describe, expect, it } from "vitest";
import { isXPostUrl, normalizeXHandle, xIntentUrl, xProfileUrl, xTweetId } from "./social";

describe("X handles", () => {
  it("strips the @ and anything that is not a handle character", () => {
    expect(normalizeXHandle("@BaseOnStocks")).toBe("BaseOnStocks");
    expect(normalizeXHandle("  @@base_on_stocks  ")).toBe("base_on_stocks");
    expect(normalizeXHandle("x.com/someone")).toBe("xcomsomeone");
  });

  it("caps at X's 15-character limit", () => {
    expect(normalizeXHandle("a".repeat(40))).toHaveLength(15);
  });

  it("builds a profile URL from whatever the creator typed", () => {
    expect(xProfileUrl("@BaseOnStocks")).toBe("https://x.com/BaseOnStocks");
  });
});

describe("X post links", () => {
  it("reads the post id from both x.com and twitter.com links", () => {
    expect(xTweetId("https://x.com/BaseOnStocks/status/1234567890123456789")).toBe("1234567890123456789");
    expect(xTweetId("https://twitter.com/someone/status/1234567890")).toBe("1234567890");
    expect(xTweetId("https://x.com/someone/status/1234567890?s=20&t=abc")).toBe("1234567890");
  });

  it("rejects a profile link, which is the mistake a creator actually makes", () => {
    expect(xTweetId("https://x.com/BaseOnStocks")).toBeNull();
    expect(isXPostUrl("https://x.com/BaseOnStocks")).toBe(false);
    expect(isXPostUrl("https://x.com/BaseOnStocks/status/1234567890")).toBe(true);
  });

  it("sends a claimant to the intent endpoint when the post id is readable", () => {
    const url = "https://x.com/BaseOnStocks/status/1234567890";
    expect(xIntentUrl("repost", url)).toBe("https://x.com/intent/repost?tweet_id=1234567890");
    expect(xIntentUrl("like", url)).toBe("https://x.com/intent/like?tweet_id=1234567890");
  });

  it("falls back to the link itself when it cannot read a post id", () => {
    expect(xIntentUrl("like", "https://x.com/BaseOnStocks")).toBe("https://x.com/BaseOnStocks");
  });
});
