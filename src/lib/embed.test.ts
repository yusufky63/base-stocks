import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  EMBED_HEIGHT,
  EMBED_SECTIONS,
  THEME_SCRIPT,
  accentStylesheet,
  accentTokens,
  contrastRatio,
  embedLinkAction,
  embedMessage,
  embedPath,
  embedResizeScript,
  embedSnippet,
  embedThemeFromLocation,
  parseEmbedAccent,
  parseEmbedEligibility,
  parseEmbedHide,
  parseEmbedRange,
  parseEmbedSide,
  parseEmbedTheme,
  withEmbedParams,
  type EmbedSection,
} from "./embed";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";
const APP = "https://basestocks.finance";

describe("widget options", () => {
  it("reads each option from the query, defaulting anything else", () => {
    expect(parseEmbedTheme("dark")).toBe("dark");
    expect(parseEmbedTheme("DARK")).toBe("auto");
    expect(parseEmbedSide("sell")).toBe("sell");
    expect(parseEmbedSide("short")).toBe("buy");
    expect(parseEmbedEligibility("always")).toBe("always");
    expect(parseEmbedEligibility("sometimes")).toBe("region");
    expect(parseEmbedRange("1w")).toBe("1W");
    expect(parseEmbedRange("5Y")).toBe("1M");
    expect(parseEmbedRange(null)).toBe("1M");
  });

  it("reads only the sections it knows, once each, in a fixed order", () => {
    expect(parseEmbedHide("limit, GIFT,chart,limit,nonsense")).toEqual(["gift", "limit", "chart"]);
    expect(parseEmbedHide(undefined)).toEqual([]);
  });

  it("never lets the price, the quote, the fees or the eligibility question be hidden", () => {
    const all = [...EMBED_SECTIONS.trade, ...EMBED_SECTIONS.stock] as string[];
    for (const kept of ["price", "quote", "fee", "fees", "review", "eligibility", "powered", "name"]) expect(all).not.toContain(kept);
  });

  it("takes a six-digit hex colour with or without #, and nothing else", () => {
    expect(parseEmbedAccent("0052FF")).toBe("#0052ff");
    expect(parseEmbedAccent("#12b76a")).toBe("#12b76a");
    for (const bad of ["blue", "#05f", "0052ffaa", "red;}body{display:none", "", null]) expect(parseEmbedAccent(bad)).toBeNull();
  });
});

describe("widget paths and code", () => {
  it("addresses a widget by the stock's contract, with only the parameters that differ from the defaults", () => {
    expect(embedPath({ widget: "trade", asset: NVDA })).toBe(`/embed/trade/${NVDA.toLowerCase()}`);
    expect(embedPath({ widget: "trade", asset: NVDA, side: "sell", theme: "dark", eligibility: "always" })).toBe(`/embed/trade/${NVDA.toLowerCase()}?side=sell&eligibility=always&theme=dark`);
    expect(embedPath({ widget: "stock", asset: NVDA, range: "1M", side: "sell", eligibility: "always" })).toBe(`/embed/stock/${NVDA.toLowerCase()}`);
    expect(embedPath({ widget: "stock", asset: NVDA, range: "1W", theme: "light" })).toBe(`/embed/stock/${NVDA.toLowerCase()}?range=1W&theme=light`);
  });

  it("puts only the widget's own sections in its path, commas left readable, and the colour without #", () => {
    const hide: EmbedSection[] = ["gift", "limit", "chart", "stats"];
    expect(embedPath({ widget: "trade", asset: NVDA, hide, accent: "#12b76a" })).toBe(`/embed/trade/${NVDA.toLowerCase()}?hide=gift,limit&accent=12b76a`);
    expect(embedPath({ widget: "stock", asset: NVDA, hide })).toBe(`/embed/stock/${NVDA.toLowerCase()}?hide=chart,stats`);
    expect(embedPath({ widget: "stock", asset: NVDA, accent: "nope" })).toBe(`/embed/stock/${NVDA.toLowerCase()}`);
  });

  it("refuses a widget without a contract address", () => {
    expect(() => embedPath({ widget: "trade", asset: "NVDA" })).toThrow();
  });

  it("gives a host an unsandboxed iframe at the widget height, with the query escaped for HTML", () => {
    const snippet = embedSnippet(`${APP}/`, { widget: "trade", asset: NVDA, theme: "dark", hide: ["gift"] });
    expect(snippet).toContain(`src="${APP}/embed/trade/${NVDA.toLowerCase()}?theme=dark&amp;hide=gift"`);
    expect(snippet).toContain(`height="${EMBED_HEIGHT.trade}"`);
    expect(snippet).not.toContain("sandbox");
    expect(embedSnippet(APP, { widget: "stock", asset: NVDA })).toContain('title="Stock price on BStocks"');
  });

  it("only lets the resize script trust this site, and only for the frame that spoke", () => {
    const script = embedResizeScript(`${APP}/`);
    expect(script).toContain(`e.origin !== '${APP}'`);
    expect(script).toContain("e.data.source !== 'bstocks'");
    expect(script).toContain("f.contentWindow === e.source");
  });

  it("stamps every message with the source a host filters on", () => {
    expect(embedMessage({ type: "trade", asset: NVDA, side: "buy", txHash: null })).toEqual({ source: "bstocks", type: "trade", asset: NVDA, side: "buy", txHash: null });
  });

  it("keeps the host's look and choices when the stock card hands over to the trade widget", () => {
    expect(withEmbedParams("/embed/trade/0x1?side=sell", "?theme=dark&accent=12b76a&hide=chart,gift&eligibility=always&range=1W")).toBe("/embed/trade/0x1?side=sell&theme=dark&eligibility=always&accent=12b76a&hide=gift,chart");
    expect(withEmbedParams("/embed/trade/0x1", "?accent=bad&hide=nope&theme=neon")).toBe("/embed/trade/0x1");
  });
});

describe("links inside a widget", () => {
  const page = `${APP}/embed/stock/${NVDA}`;
  it("keeps widget pages in the frame and sends the rest of the web to a new tab", () => {
    expect(embedLinkAction(`/embed/trade/${NVDA}`, page)).toBe("frame");
    expect(embedLinkAction("/how-it-works", page)).toBe("new-tab");
    expect(embedLinkAction("https://basescan.org/tx/0x1", page)).toBe("new-tab");
  });
  it("leaves alone links that choose their own target or are not web pages", () => {
    expect(embedLinkAction("https://basescan.org", page, "_blank")).toBe("default");
    expect(embedLinkAction("mailto:hi@example.com", page)).toBe("default");
    expect(embedLinkAction("#top", page)).toBe("default");
    expect(embedLinkAction(null, page)).toBe("default");
  });
});

describe("widget colour", () => {
  it("derives the five primary tokens per theme, with readable button text", () => {
    const blue = accentTokens("#0052ff");
    expect(blue.light["--primary"]).toBe("#0052ff");
    expect(blue.light["--primary-fill"]).toBe("#0052ff");
    expect(blue.light["--primary-contrast"]).toBe("#ffffff");
    expect(blue.dark["--primary-soft"]).toBe("rgba(0, 82, 255, 0.16)");
    expect(contrastRatio(blue.light["--primary-strong"]!, "#ffffff")).toBeGreaterThan(contrastRatio("#0052ff", "#ffffff"));
    expect(contrastRatio(blue.dark["--primary-strong"]!, "#0a0b0d")).toBeGreaterThan(contrastRatio("#0052ff", "#0a0b0d"));
    expect(accentTokens("#ffd60a").light["--primary-contrast"]).toBe("#0a0b0d");
  });

  it("writes a stylesheet on the root, for every theme, only from a parsed colour", () => {
    const css = accentStylesheet("#12b76a");
    expect(css).toContain(":root:root{--primary:#12b76a;");
    expect(css).toContain(':root:root[data-theme="dark"]{');
    expect(css).toContain('@media (prefers-color-scheme: dark){:root:root:not([data-theme="light"]){');
    expect(accentStylesheet(null)).toBe("");
    expect(accentStylesheet("#12b76a;}body{display:none")).toBe("");
    expect(accentStylesheet("</style><script>")).toBe("");
  });
});

/** Runs the pre-paint script against a fake page, the way the browser runs it before first paint. */
function runThemeScript(pathname: string, search: string, stored: Record<string, string>, storage = true) {
  const attrs: Record<string, string> = {};
  const context = {
    location: { pathname, search },
    URLSearchParams,
    localStorage: {
      getItem: (k: string) => {
        if (!storage) throw new Error("denied");
        return stored[k] ?? null;
      },
    },
    document: { documentElement: { setAttribute: (k: string, v: string) => void (attrs[k] = v) } },
  };
  runInNewContext(THEME_SCRIPT, context);
  return attrs;
}

describe("theme before paint", () => {
  it("keeps the visitor's stored theme and motion everywhere but a widget that names one", () => {
    expect(runThemeScript("/stocks/0x1", "?theme=dark", { "bstocks:theme": "light", "bstocks:motion": "off" })).toEqual({ "data-theme": "light", "data-motion": "off" });
    expect(runThemeScript("/embed/trade/0x1", "?theme=dark", { "bstocks:theme": "light" })).toEqual({ "data-theme": "dark", "data-motion": "system" });
    expect(runThemeScript("/embed/trade/0x1", "", { "bstocks:theme": "light" })["data-theme"]).toBe("light");
  });

  it("still applies the host's theme in a frame that is refused storage", () => {
    expect(runThemeScript("/embed/stock/0x1", "?theme=dark", {}, false)).toEqual({ "data-theme": "dark", "data-motion": "system" });
  });

  it("gives the wallet modal the same answer after paint", () => {
    expect(embedThemeFromLocation({ pathname: "/embed/trade/0x1", search: "?theme=dark" })).toBe("dark");
    expect(embedThemeFromLocation({ pathname: "/embed/trade/0x1", search: "" })).toBeNull();
    expect(embedThemeFromLocation({ pathname: "/stocks/0x1", search: "?theme=dark" })).toBeNull();
  });
});
