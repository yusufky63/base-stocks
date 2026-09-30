import { PRO_PRICE_USD, V1_CAVEATS, V1_ENDPOINTS, V1_GROUPS, type V1Endpoint, type V1Param } from "./catalog";

/**
 * The public API as an OpenAPI 3.1 document, built from the catalog: typed parameters, the trade
 * body, the errors each route answers, and the x402 scheme on the paid ones. Pure, so a test can
 * read it without a request.
 */

export const API_BASE = "https://basestocks.finance";

type Schema = Record<string, unknown>;

function schemaOf(p: V1Param): Schema {
  const base: Schema = { description: p.description };
  switch (p.type) {
    case "address":
      return { ...base, type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
    case "uint":
      return { ...base, type: "string", pattern: "^[1-9][0-9]*$" };
    case "integer":
      return { ...base, type: "integer", ...(p.min !== undefined ? { minimum: p.min } : {}), ...(p.max !== undefined ? { maximum: p.max } : {}), ...(p.default ? { default: Number(p.default) } : {}) };
    case "boolean":
      return { ...base, type: "boolean" };
    case "enum":
      return { ...base, type: "string", enum: [...(p.enum ?? [])], ...(p.default ? { default: p.default } : {}) };
    default:
      return { ...base, type: "string", ...(p.default ? { default: p.default } : {}) };
  }
}

/** `"404 UNKNOWN_STOCK"` → status and code; free-text entries ("4xx from …") describe a family. */
function errorResponses(e: V1Endpoint): Record<string, Schema> {
  const out: Record<string, Schema> = {};
  for (const entry of e.errors) {
    const m = /^(\d{3}) ([A-Z_]+)$/.exec(entry);
    const status = m ? m[1]! : "default";
    const code = m ? m[2]! : entry;
    const existing = out[status]?.description as string | undefined;
    out[status] = {
      description: existing ? `${existing} · ${code}` : code,
      ...(status === "402" ? {} : { content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }),
    };
  }
  return out;
}

function operation(e: V1Endpoint): Schema {
  const inUrl = (e.params ?? []).filter((p) => p.in !== "body");
  const inBody = (e.params ?? []).filter((p) => p.in === "body");
  const required = inBody.filter((p) => p.required).map((p) => p.name);
  return {
    operationId: e.id,
    summary: e.summary,
    tags: [V1_GROUPS.find((g) => g.id === e.group)!.title],
    ...(inUrl.length > 0 ? { parameters: inUrl.map((p) => ({ name: p.name, in: p.in, required: p.in === "path" ? true : p.required, schema: schemaOf(p) })) } : {}),
    ...(inBody.length > 0
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", properties: Object.fromEntries(inBody.map((p) => [p.name, schemaOf(p)])), required, additionalProperties: false },
                ...(e.body ? { example: e.body } : {}),
              },
            },
          },
        }
      : {}),
    responses: {
      "200": { description: e.returns, content: { "application/json": { schema: { $ref: "#/components/schemas/Envelope" } } } },
      ...errorResponses(e),
    },
    ...(e.paid ? { security: [{ x402: [] }] } : {}),
    ...(e.cacheSeconds > 0 ? { "x-cache-seconds": e.cacheSeconds } : {}),
    ...(e.limitPerMinute ? { "x-rate-limit-per-minute": e.limitPerMinute } : {}),
    ...(e.eligibility ? { "x-eligibility": "Answers 451 from a restricted country until the visitor confirms they are not a US person." } : {}),
  };
}

export function buildOpenApi(network: string): Schema {
  const paths: Record<string, Record<string, Schema>> = {};
  for (const e of V1_ENDPOINTS) {
    paths[e.path] ??= {};
    paths[e.path]![e.method.toLowerCase()] = operation(e);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "BStocks API",
      version: "1.0.0",
      description: [
        "Data on Coinbase Tokenized Stocks (B20) on Base, and the calls to trade them.",
        "",
        `Free endpoints need no key and no account; CORS is open to every origin. Two endpoints that cost real work to produce are priced at ${PRO_PRICE_USD} in USDC per call over x402. POST /api/v1/trade returns the calls for the user's own wallet to sign: nothing is signed or sent on the server.`,
        "",
        ...V1_CAVEATS.map((c) => `**${c.title}.** ${c.body}`),
      ].join("\n"),
      contact: { url: `${API_BASE}/developers` },
    },
    servers: [{ url: API_BASE }],
    externalDocs: { description: "Developer docs with every example runnable", url: `${API_BASE}/developers` },
    tags: V1_GROUPS.map((g) => ({ name: g.title, description: g.intro })),
    paths,
    components: {
      schemas: {
        Envelope: {
          type: "object",
          required: ["data", "meta"],
          properties: {
            data: { description: "The endpoint's payload." },
            meta: {
              type: "object",
              properties: {
                generatedAt: { type: "integer", description: "Unix ms when this body was built." },
                cacheSeconds: { type: "integer", description: "How long this body may be reused; the CDN honours the same number." },
                docs: { type: "string" },
              },
            },
          },
        },
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, hint: { type: "string" } } },
          },
        },
      },
      securitySchemes: {
        x402: {
          type: "http",
          scheme: "x402",
          description: `Pay-per-call in USDC on ${network}. An unpaid request answers 402 with the payment requirements; sign the authorization and retry. Settlement happens only after a successful response, so a failed call costs nothing.`,
        },
      },
    },
  };
}
