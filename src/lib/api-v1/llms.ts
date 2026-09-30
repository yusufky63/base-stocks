import { CURATED_B20_ASSETS } from "@/lib/b20/registry";
import { PRO_PRICE_USD, V1_CAVEATS, V1_ENDPOINTS, V1_GROUPS, apiRules, endpointsIn, type V1Endpoint, type V1Param } from "./catalog";
import { curlOf, exampleRequest } from "./try";

/**
 * The whole public API in one plain-text file, for a model's context or an agent's tools:
 * conventions, every endpoint with its parameters, errors and a curl line, a trade example, and the
 * listed stocks. Built from the catalog, as llms.txt and the OpenAPI document are.
 */

function paramLine(p: V1Param): string {
  const range = p.min !== undefined || p.max !== undefined ? ` ${p.min ?? ""}..${p.max ?? ""}` : "";
  const choices = p.enum ? ` one of ${p.enum.join(" | ")}` : "";
  const fallback = p.default ? ` (default ${p.default})` : "";
  return `- \`${p.name}\` (${p.in}, ${p.type ?? "string"}${range}${choices}, ${p.required ? "required" : "optional"})${fallback}: ${p.description}`;
}

function endpointSection(e: V1Endpoint, base: string): string[] {
  const tags = [e.paid ? `paid: ${PRO_PRICE_USD} USDC per call over x402` : "free", e.cacheSeconds > 0 ? `cached ${e.cacheSeconds}s` : "not cached", e.limitPerMinute ? `${e.limitPerMinute}/min per caller` : null, e.eligibility ? "eligibility rule applies" : null]
    .filter(Boolean)
    .join(" · ");
  return [
    `### ${e.method} ${e.path}`,
    "",
    e.summary,
    "",
    `(${tags})`,
    "",
    ...(e.params && e.params.length > 0 ? ["Parameters:", "", ...e.params.map(paramLine), ""] : []),
    `Returns: data = ${e.returns}`,
    "",
    ...(e.errors.length > 0 ? [`Errors: ${e.errors.join(", ")}`, ""] : []),
    "```sh",
    curlOf(exampleRequest(e, base)),
    "```",
    "",
  ];
}

/** A trade through the API: ask for the calls, then the user's wallet sends them in order. */
export function tradeExample(base: string): string {
  return [
    "// 1. Ask for the calls. amount is what is sold, in its smallest unit: 10 USDC = 10000000.",
    `const res = await fetch("${base}/api/v1/trade", {`,
    '  method: "POST",',
    '  headers: { "content-type": "application/json" },',
    '  body: JSON.stringify({ stock: "NVDA", side: "buy", amount: "10000000", account, builderCode: "bc_yourcode" }),',
    "});",
    "const { data, error } = await res.json();",
    "if (error) throw new Error(error.message);",
    "",
    "// 2. The user's wallet sends them in order: the approval first, when there is one.",
    "//    A quote lives for data.expiresAt; ask again if the approval took longer.",
    "for (const call of data.calls) {",
    "  const hash = await walletClient.sendTransaction({ account, to: call.to, data: call.data, value: BigInt(call.value) });",
    "  await publicClient.waitForTransactionReceipt({ hash });",
    "}",
  ].join("\n");
}

export function llmsFullTxt(base: string): string {
  const lines = [
    "# BStocks: full API reference",
    "",
    "> Self-custodial interface for Coinbase Tokenized Stocks (B20) on Base, and a public API for the data behind it and the calls to trade it.",
    "",
    "## Conventions",
    "",
    ...apiRules(base).map((r) => `- ${r.label}: ${r.text}`),
    "",
    "## Read this before using the data",
    "",
    ...V1_CAVEATS.map((c) => `- **${c.title}.** ${c.body}`),
    "",
    "## Quick start: a trade",
    "",
    "```js",
    tradeExample(base),
    "```",
    "",
  ];
  for (const group of V1_GROUPS) {
    lines.push(`## ${group.title}`, "", group.intro, "");
    for (const e of endpointsIn(group.id)) lines.push(...endpointSection(e, base));
  }
  lines.push(
    "## Listed stocks",
    "",
    "Identity is the contract address; tickers are accepted for convenience. Stocks Coinbase lists later are discovered onchain and appear in /api/v1/stocks.",
    "",
    ...CURATED_B20_ASSETS.map((a) => `- ${a.underlying}: ${a.address}`),
    "",
    `Endpoints in this file: ${V1_ENDPOINTS.length}. OpenAPI: ${base}/api/v1/openapi.json. Docs with runnable examples: ${base}/developers.`,
    "",
  );
  return lines.join("\n");
}
