import { describe, expect, it } from "vitest";
import { normalizeMarketOutput } from "./digest-service";

const allowed = new Set(["NVDA", "AAPL", "COIN", "INTC"]);
const meta = { marketOpen: false, headlines: 42, sources: 7, model: "test", now: 1_000 };

describe("normalising the market brief", () => {
  it("keeps only listed tickers, trims text and caps the lists", () => {
    const d = normalizeMarketOutput(
      {
        headline: "  A quiet <b>day</b>  ",
        summary: "Summary.",
        bullets: [
          { ticker: "nvda", note: "Up 2%." },
          { ticker: "SPY", note: "Not listed." },
          { ticker: "NVDAc", note: "Suffixed form is fine." },
          { ticker: "INTC", note: "" },
        ],
        spotlight: [
          { note: "Coinbase listed six more stocks on Base.", tickers: ["nvda", "SPY"] },
          { note: "Up 2%.", tickers: [] },
        ],
        themes: ["chips", "", "listings on Base", "a", "b", "c"],
        mood: "VOLATILE",
      },
      allowed,
      meta,
    );
    expect(d.headline).toBe("A quiet day");
    expect(d.bullets).toEqual([
      { ticker: "NVDA", note: "Up 2%." },
      { ticker: "NVDA", note: "Suffixed form is fine." },
    ]);
    // A spotlight item that merely repeats a bullet is dropped; unknown tickers are stripped.
    expect(d.spotlight).toEqual([{ note: "Coinbase listed six more stocks on Base.", tickers: ["NVDA"] }]);
    expect(d.themes).toEqual(["chips", "listings on Base", "a", "b"]);
    expect(d.mood).toBe("volatile");
    expect(d).toMatchObject({ headlines: 42, sources: 7, model: "test", generatedAt: 1_000, marketOpen: false });
  });

  /** "COIN" and "INTC" end with a C that is part of the ticker, not the B20 suffix. */
  it("does not mistake a trailing C of a real ticker for the token suffix", () => {
    const d = normalizeMarketOutput({ headline: "h", summary: "s", bullets: [{ ticker: "COIN", note: "x" }, { ticker: "INTC", note: "y" }], mood: "calm" }, allowed, meta);
    expect(d.bullets.map((b) => b.ticker)).toEqual(["COIN", "INTC"]);
  });

  it("treats missing lists and an unknown mood as empty and mixed", () => {
    const d = normalizeMarketOutput({ headline: "h", summary: "s" }, allowed, meta);
    expect(d.bullets).toEqual([]);
    expect(d.spotlight).toEqual([]);
    expect(d.themes).toEqual([]);
    expect(d.mood).toBe("mixed");
  });
});
