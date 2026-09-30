import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CURATED_B20_ASSETS } from "@/lib/b20/registry";
import { V1_CAVEATS, V1_ENDPOINTS, V1_GROUPS, apiRules } from "./catalog";
import { llmsFullTxt } from "./llms";
import { buildOpenApi } from "./openapi";
import { V1_TRADE_LIMIT } from "./trade";
import { buildRequest, curlOf, exampleRequest, exampleValues } from "./try";

const root = join(process.cwd(), "src");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const byId = (id: string) => V1_ENDPOINTS.find((e) => e.id === id)!;
const routeFile = (path: string) => `app${path.replace(/\{(\w+)\}/g, "[$1]")}/route.ts`;

/** Every v1 route file with the HTTP methods it serves (OPTIONS is the CORS preflight, not an endpoint). */
function servedRoutes(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name === "route.ts" ? [join(dir, d.name)] : []));
  return walk(join(root, "app/api/v1")).flatMap((file) => {
    const path = `/${relative(join(root, "app"), file).replaceAll("\\", "/").replace(/\/route\.ts$/, "").replace(/\[(\w+)\]/g, "{$1}")}`;
    const source = readFileSync(file, "utf8");
    return (["GET", "POST"] as const).filter((m) => new RegExp(`export (?:async function|const|function) ${m}\\b`).test(source)).map((m) => `${m} ${path}`);
  });
}

describe("the catalog matches the routes", () => {
  it("describes every endpoint the API serves, besides the index and the spec that describe it", () => {
    const served = servedRoutes().filter((r) => r !== "GET /api/v1" && r !== "GET /api/v1/openapi.json").sort();
    expect(served.length).toBeGreaterThan(8);
    expect(V1_ENDPOINTS.map((e) => `${e.method} ${e.path}`).sort()).toEqual(served);
  });

  it("keeps ids unique and every group used", () => {
    expect(new Set(V1_ENDPOINTS.map((e) => e.id)).size).toBe(V1_ENDPOINTS.length);
    for (const g of V1_GROUPS) expect(V1_ENDPOINTS.some((e) => e.group === g.id), g.id).toBe(true);
  });

  it("names only parameters the route reads", () => {
    for (const e of V1_ENDPOINTS) {
      const source = read(routeFile(e.path));
      for (const p of e.params ?? []) {
        if (p.in === "path") expect(e.path, `${e.id}.${p.name}`).toContain(`{${p.name}}`);
        else expect(source, `${e.id}.${p.name}`).toMatch(new RegExp(`\\b${p.name}\\b`));
      }
    }
  });

  it("states the limits the routes enforce", () => {
    expect(byId("trade").limitPerMinute).toBe(V1_TRADE_LIMIT.limit);
    expect(read(routeFile("/api/v1/portfolio/{address}"))).toContain(`limit: ${byId("portfolio").limitPerMinute}`);
    expect(V1_ENDPOINTS.filter((e) => e.eligibility).map((e) => e.id)).toEqual(["trade"]);
    expect(read("proxy.ts")).toContain("/^\\/api\\/v1\\/trade\\/?$/");
  });

  it("marks exactly the endpoints the x402 wrapper guards as paid", () => {
    for (const e of V1_ENDPOINTS) expect(read(routeFile(e.path)).includes("withPayment("), e.id).toBe(e.paid);
  });
});

describe("Try it and curl", () => {
  it("starts every form from the endpoint's own example, required fields filled", () => {
    for (const e of V1_ENDPOINTS) {
      const values = exampleValues(e);
      for (const p of (e.params ?? []).filter((x) => x.required)) expect(values[p.name], `${e.id}.${p.name}`).toBeTruthy();
      if (e.method === "GET") expect(exampleRequest(e).url, e.id).toBe(e.example);
    }
    expect(exampleValues(byId("history"))).toEqual({ symbol: "NVDA", timeframe: "1M" });
  });

  it("sends only what was typed, typed the way the route expects", () => {
    const trade = buildRequest(byId("trade"), { stock: "NVDA", side: "buy", amount: "5", account: "0xabc", slippageBps: "200", recipient: "" }, "https://x.test");
    expect(trade).toEqual({ method: "POST", url: "https://x.test/api/v1/trade", headers: { "content-type": "application/json" }, body: JSON.stringify({ stock: "NVDA", side: "buy", amount: "5", account: "0xabc", slippageBps: 200 }) });
    expect(buildRequest(byId("news"), { scope: "market", limit: "3", symbol: "" }).url).toBe("/api/v1/news?scope=market&limit=3");
    expect(curlOf({ method: "POST", url: "https://x.test/a", headers: {}, body: `{"n":"it's"}` })).toContain(`-d '{"n":"it'\\''s"}'`);
  });
});

describe("machine-readable versions", () => {
  const spec = buildOpenApi("base") as { paths: Record<string, Record<string, { operationId: string; parameters?: { name: string; in: string }[]; requestBody?: { content: { "application/json": { schema: { required: string[] } } } }; security?: unknown; responses: Record<string, unknown> }>> };

  it("puts every endpoint in the OpenAPI document, typed, with its errors", () => {
    for (const e of V1_ENDPOINTS) {
      const op = spec.paths[e.path]?.[e.method.toLowerCase()];
      expect(op, e.id).toBeDefined();
      expect(op!.operationId).toBe(e.id);
      for (const name of [...e.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1])) expect(op!.parameters?.some((p) => p.name === name && p.in === "path"), `${e.id}.${name}`).toBe(true);
      expect(Boolean(op!.security), e.id).toBe(e.paid);
      for (const err of e.errors) {
        const status = /^(\d{3}) /.exec(err)?.[1];
        if (status) expect(op!.responses[status], `${e.id} ${err}`).toBeDefined();
      }
    }
    const trade = spec.paths["/api/v1/trade"]!.post!;
    expect(trade.requestBody!.content["application/json"].schema.required).toEqual(["stock", "side", "amount", "account"]);
  });

  it("writes the whole reference into llms-full.txt", () => {
    const text = llmsFullTxt("https://basestocks.finance");
    for (const e of V1_ENDPOINTS) expect(text, e.id).toContain(`### ${e.method} ${e.path}`);
    for (const rule of apiRules("https://basestocks.finance")) expect(text).toContain(rule.text);
    for (const c of V1_CAVEATS) expect(text).toContain(c.title);
    for (const a of CURATED_B20_ASSETS) expect(text).toContain(a.address);
    expect(text).toContain("curl -s -X POST 'https://basestocks.finance/api/v1/trade'");
  });
});
