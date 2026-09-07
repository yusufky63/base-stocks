import { V1_CAVEATS, V1_ENDPOINTS } from "@/lib/api-v1/catalog";
import { V1_CORS } from "@/lib/api-v1/respond";
import { PRO_PRICE_USD, paymentInfo } from "@/lib/api-v1/x402";

const BASE = "https://basestocks.finance";

/**
 * OpenAPI 3.1 for the public API, generated from the same catalog the docs page reads, so the
 * schema cannot drift from the endpoints it describes. Served as a document rather than kept as a
 * file for the same reason.
 */
export async function GET(): Promise<Response> {
  const paths: Record<string, unknown> = {};
  for (const e of V1_ENDPOINTS) {
    paths[e.path] = {
      get: {
        summary: e.summary,
        operationId: e.path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, ""),
        parameters: (e.params ?? []).map((p) => ({ name: p.name, in: p.in, required: p.required, description: p.description, schema: { type: "string" } })),
        responses: {
          "200": { description: "Success", content: { "application/json": { schema: { $ref: "#/components/schemas/Envelope" } } } },
          "404": { description: "No such stock or wallet" },
          ...(e.paid
            ? { "402": { description: `Payment required: ${PRO_PRICE_USD} in USDC over x402. The response carries the amount, asset, network and recipient; sign it and retry the same request.` } }
            : {}),
        },
        ...(e.paid ? { security: [{ x402: [] }] } : {}),
      },
    };
  }

  const doc = {
    openapi: "3.1.0",
    info: {
      title: "BaseStocks API",
      version: "1.0.0",
      description: [
        "Read-only data on Coinbase Tokenized Stocks (B20) on Base.",
        "",
        "Free endpoints need no key, no headers and no account. Two endpoints that cost real work to produce are priced per call in USDC over x402.",
        "",
        ...V1_CAVEATS.map((c) => `**${c.title}.** ${c.body}`),
      ].join("\n"),
      contact: { url: `${BASE}/developers` },
    },
    servers: [{ url: BASE }],
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
      },
      securitySchemes: {
        x402: {
          type: "http",
          scheme: "x402",
          description: `Pay-per-call in USDC on ${paymentInfo().network}. An unpaid request answers 402 with the payment requirements; sign the authorization and retry. Settlement happens only after a successful response, so a failed call costs nothing.`,
        },
      },
    },
  };

  return new Response(JSON.stringify(doc, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, s-maxage=600, stale-while-revalidate=3600", ...V1_CORS },
  });
}
