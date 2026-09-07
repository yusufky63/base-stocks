import { V1_CAVEATS, V1_ENDPOINTS } from "@/lib/api-v1/catalog";
import { PRO_PRICE_USD, paymentInfo } from "@/lib/api-v1/x402";

const BASE = "https://basestocks.finance";

/**
 * The convention Base's own docs follow: a plain-text index an assistant can read in one fetch to
 * learn what exists before going deeper. Generated from the endpoint catalog so it cannot fall
 * behind the API it describes.
 */
export async function GET(): Promise<Response> {
  const pay = paymentInfo();
  const body = [
    "# BaseStocks",
    "",
    "> Self-custodial interface for Coinbase Tokenized Stocks (B20) on Base, and a public read-only API for the data behind it: prices, Chainlink references, liquidity, news, USDC yield venues, wallet positions and platform statistics.",
    "",
    "Every free endpoint is a plain GET: no key, no headers, no account, open CORS. Responses are JSON in a `{ data, meta }` envelope and are cached at the edge, so reading them costs the app nothing.",
    "",
    "## API",
    "",
    ...V1_ENDPOINTS.map((e) => `- [${e.path}](${BASE}${e.example}): ${e.summary}${e.paid ? "" : ` Cached ${e.cacheSeconds}s.`}`),
    `- [OpenAPI](${BASE}/api/v1/openapi.json): machine-readable schema for the above.`,
    `- [Developer docs](${BASE}/developers): the same endpoints with live examples you can run.`,
    "",
    "## Paid endpoints",
    "",
    `The two endpoints marked above cost ${PRO_PRICE_USD} in USDC per call over x402 on ${pay.network}. An unpaid request answers 402 with the amount, asset, network and recipient; sign the authorization and retry the same URL. Settlement happens only after a successful response, so a failed call is never charged.`,
    "",
    "## Read this before using the data",
    "",
    ...V1_CAVEATS.map((c) => `- **${c.title}.** ${c.body}`),
    "",
    "## About the app",
    "",
    `- [How it works](${BASE}/how-it-works): what the product does, in plain words.`,
    `- [Technical docs](${BASE}/docs): the B20 standard, price model, routing, limit orders, gift escrow and contract addresses.`,
    `- [Status](${BASE}/status): live checks of every dependency.`,
    "",
    "Coinbase tokenized stocks are available only to eligible persons outside the United States. This API reports public chain data; it does not offer or execute a trade.",
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400", "access-control-allow-origin": "*" },
  });
}
