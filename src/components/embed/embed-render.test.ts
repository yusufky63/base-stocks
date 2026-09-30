import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ComponentProps, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { WagmiProvider, createConfig, custom } from "wagmi";
import { base } from "wagmi/chains";
import { describe, expect, it, vi } from "vitest";
import type { AssetResponse, RegionResponse } from "@/lib/client-api";
import type { EmbedSection } from "@/lib/embed";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/embed/trade/0x1",
}));

const { EmbedShell } = await import("./EmbedShell");
const { TradeWidget } = await import("./TradeWidget");
const { StockWidget } = await import("./StockWidget");
const { WidgetBuilder } = await import("@/components/widgets/WidgetBuilder");
const { ThemeProvider } = await import("@/components/layout/ThemeProvider");

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as const;

/** Server-renders under a wagmi config whose transport refuses every request, with the region answer already cached. */
function render(element: ReactElement, region?: RegionResponse): string {
  const config = createConfig({ chains: [base], connectors: [], transports: { [base.id]: custom({ request: async () => Promise.reject(new Error("no network in tests")) }) } });
  const client = new QueryClient();
  if (region) client.setQueryData(["region"], region);
  return renderToString(createElement(WagmiProvider, { config }, createElement(QueryClientProvider, { client }, createElement(ThemeProvider, null, element))))
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'");
}

const data: AssetResponse = {
  asset: {
    address: NVDA,
    canonicalId: "base:nvda",
    name: "NVIDIA",
    symbol: "NVDAc",
    underlying: "NVDA",
    decimals: 18,
    tags: ["technology"],
    multiplier: "1000000000000000000",
    wadPrecision: "1000000000000000000",
    totalSupply: "1000000000000000000000",
    transferPaused: false,
    transferSenderPolicyId: "0",
    transferReceiverPolicyId: "0",
    status: "active",
    verification: "verified",
    readAt: 0,
  } as unknown as AssetResponse["asset"],
  price: {
    address: NVDA,
    marketUsd: 181.2,
    marketChange24hPct: 1.5,
    marketUpdatedAt: 0,
    liquidityUsd: 2_500_000,
    volume24hUsd: 410_000,
    referenceFreshness: "live",
    referenceUsd: 181,
    referenceStale: false,
    referencePaused: false,
    referenceUpdatedAt: 0,
    displayUsd: 181.2,
    displaySource: "market",
    deviationPct: 0.1,
    marketCapUsd: 42_000_000,
  } as unknown as AssetResponse["price"],
};

const region = (over: Partial<RegionResponse>): RegionResponse => ({ country: "TR", blocked: ["US"], mode: "attest", blockedCountry: false, attested: false, restricted: false, ...over });
const US = region({ country: "US", blockedCountry: true, restricted: true });
const ATTEST = "I confirm that I am not a US person";

/** The shell around one widget, its content passed the way createElement takes children. */
const shell = (props: Omit<ComponentProps<typeof EmbedShell>, "children">, child: ReactElement) => createElement(EmbedShell, props as ComponentProps<typeof EmbedShell>, child);
const trade = (opts: { hide?: EmbedSection[]; eligibility?: "region" | "always"; state?: RegionResponse } = {}) =>
  render(shell({ widget: "trade", hide: opts.hide ?? [], eligibility: opts.eligibility ?? "region" }, createElement(TradeWidget, { address: NVDA, initialData: data })), opts.state ?? region({}));
const stock = (hide: EmbedSection[] = [], accent: string | null = null) =>
  render(shell({ widget: "stock", hide, accent }, createElement(StockWidget, { address: NVDA, initialData: data, range: "1W" })), region({}));

describe("trade widget", () => {
  it("is the site's trade panel under the stock's name and price, with a way out to the full page", () => {
    const html = trade();
    expect(html).toContain("NVIDIA");
    expect(html).toContain("$181.20");
    expect(html).toContain('aria-label="Trade mode"');
    expect(html).toMatch(/<a href="[^"]+\/stocks\/0xb2[^"]*" target="_blank"[^>]*aria-label="Open the full stock page"/);
    for (const text of ["Pay with", "Buy amount slider", "Buy for someone else", "Limit", "Execution details", "Powered by"]) expect(html).toContain(text);
  });

  it("leaves out exactly what the host hid, and keeps the quote and the button", () => {
    const html = trade({ hide: ["header", "pay", "presets", "gift", "limit", "details", "routes"] });
    for (const text of ["Open the full stock page", "Pay with", "Buy amount slider", "Buy for someone else", ">Limit<", "Execution details"]) expect(html).not.toContain(text);
    for (const text of ["Live quote", 'aria-label="Amount in US dollars"', "Connect", "Powered by"]) expect(html).toContain(text);
  });

  it("asks a US connection at the button, in the frame and not in a dialog", () => {
    const html = trade({ state: US });
    expect(html).toContain(ATTEST);
    const dialogs = [...html.matchAll(/<dialog[\s\S]*?<\/dialog>/g)].map((m) => m[0]);
    expect(dialogs.some((d) => d.includes(ATTEST))).toBe(false);
  });

  it("asks every visitor where the host chose it, and stops once they answered", () => {
    expect(trade()).not.toContain(ATTEST);
    expect(trade({ eligibility: "always" })).toContain(ATTEST);
    expect(trade({ eligibility: "always", state: region({ attested: true }) })).not.toContain(ATTEST);
    // A deployment in block mode still takes the statement from a country it does not refuse.
    expect(trade({ eligibility: "always", state: region({ mode: "block" }) })).toContain(ATTEST);
  });
});

describe("stock widget", () => {
  it("shows the price, the daily move, the chart and the market, with buttons into the trade widget", () => {
    const html = stock();
    for (const text of ["NVIDIA", "$181.20", "+1.50%", 'aria-label="Timeframe"', "Market cap", "Pool liquidity", "Volume 24h", "Buy NVDA", "Sell"]) expect(html).toContain(text);
  });

  it("leaves out the chart, its ranges, the stats or the buttons when the host asks", () => {
    expect(stock(["range"])).not.toContain('aria-label="Timeframe"');
    expect(stock(["range"])).toContain(">1W<");
    const bare = stock(["chart", "stats", "trade"]);
    for (const text of ["Timeframe", "Market cap", "Buy NVDA"]) expect(bare).not.toContain(text);
    expect(bare).toContain("$181.20");
  });

  it("carries the host colour into the page", () => {
    expect(stock([], "#12b76a")).toContain("<style>:root:root{--primary:#12b76a;");
    expect(stock()).not.toContain(":root:root");
  });
});

describe("widget builder", () => {
  it("starts on NVDA with a copyable iframe, a live preview and the style controls", () => {
    const html = render(createElement(WidgetBuilder, {}));
    expect(html).toContain(`<iframe src="/embed/trade/${NVDA.toLowerCase()}"`);
    expect(html).toContain("Paste into your page");
    for (const text of ["Eligibility check", "Primary colour", 'aria-label="Sections to hide"', "Limit orders", "Route choice"]) expect(html).toContain(text);
  });
});
