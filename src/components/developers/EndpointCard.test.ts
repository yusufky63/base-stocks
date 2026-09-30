import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PRO_PRICE_USD, V1_ENDPOINTS } from "@/lib/api-v1/catalog";
import { EndpointCard } from "./EndpointCard";

const byId = (id: string) => V1_ENDPOINTS.find((e) => e.id === id)!;
const render = (id: string) =>
  renderToString(createElement(EndpointCard, { endpoint: byId(id), base: "https://basestocks.finance" }))
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');

describe("endpoint card", () => {
  it("shows the trade builder as a POST with its limits, parameters and a filled-in Try it", () => {
    const html = render("trade");
    expect(html).toContain('id="trade"');
    expect(html).toContain(">POST</span>");
    expect(html).toContain(`${byId("trade").limitPerMinute}/min`);
    expect(html).toContain(">eligibility<");
    for (const p of byId("trade").params!) expect(html).toContain(p.name);
    expect(html).toContain('value="NVDA"');
    expect(html).toContain("curl -s -X POST 'https://basestocks.finance/api/v1/trade'");
    expect(html).toContain("Send request");
  });

  it("shows a paid endpoint's price and a read's cache window", () => {
    expect(render("report")).toContain(`${PRO_PRICE_USD.replace("$", "")} USDC`);
    const stocks = render("stocks");
    expect(stocks).toContain("cached 30s");
    expect(stocks).toContain("curl -s 'https://basestocks.finance/api/v1/stocks'");
  });
});

describe("developers page anchors", () => {
  it("never gives a group the same anchor as an endpoint card", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(`${process.cwd()}/src/app/developers/page.tsx`, "utf8");
    const anchor = (id: string) => (id === "pro" ? "paid" : id === "trade" ? "trading" : id);
    expect(page).toContain('const groupAnchor = (id: string) => (id === "pro" ? "paid" : id === "trade" ? "trading" : id);');
    const { V1_GROUPS } = await import("@/lib/api-v1/catalog");
    const cards = new Set(V1_ENDPOINTS.map((e) => e.id));
    for (const g of V1_GROUPS) expect(cards.has(anchor(g.id)), g.id).toBe(false);
    for (const intro of ["start", "read-first", "agents"]) expect(cards.has(intro), intro).toBe(false);
  });
});
