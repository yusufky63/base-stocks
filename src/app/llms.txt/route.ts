import { V1_CAVEATS, V1_ENDPOINTS } from "@/lib/api-v1/catalog";
import { PRO_PRICE_USD, paymentInfo } from "@/lib/api-v1/x402";
import { publicEnv } from "@/config/env";
import { CURATED_B20_ASSETS } from "@/lib/b20/registry";

/**
 * The convention Base's own docs follow: a plain-text index an assistant can read in one fetch to
 * learn what exists before going deeper. Generated from the endpoint catalog and the curated stock
 * list so it cannot fall behind the API it describes. The base URL is the deployment's own, so a
 * preview deployment describes itself rather than production.
 */
export async function GET(): Promise<Response> {
  const base = publicEnv.appUrl.replace(/\/$/, "");
  const pay = paymentInfo();
  const paidCount = V1_ENDPOINTS.filter((e) => e.paid).length;
  const body = [
    "# BStocks",
    "",
    "> Self-custodial interface for Coinbase Tokenized Stocks (B20) on Base, and a public API for the data behind it (prices, Chainlink references, liquidity, news, USDC yield venues, wallet positions, platform statistics) and the calls to trade it.",
    "",
    "Free endpoints need no key, no account and no headers; CORS is open to every origin. Responses are JSON in a `{ data, meta }` envelope and the reads are cached at the edge, so reading them costs the app nothing. POST /api/v1/trade returns the calls for the user's own wallet to sign; nothing is signed or sent on the server.",
    "",
    "## API",
    "",
    ...V1_ENDPOINTS.map((e) => `- [${e.method} ${e.path}](${base}${e.method === "GET" ? e.example : `/developers#${e.id}`}): ${e.summary}${e.paid ? ` Paid: ${PRO_PRICE_USD} USDC per call (x402).` : e.cacheSeconds > 0 ? ` Cached ${e.cacheSeconds}s.` : ` ${e.limitPerMinute ?? 30} a minute per caller.`}`),
    `- [Full reference in one file](${base}/llms-full.txt): conventions, every parameter and error, curl lines and a trade example.`,
    `- [OpenAPI](${base}/api/v1/openapi.json): machine-readable schema for the above.`,
    `- [Developer docs](${base}/developers): the same endpoints with a Try it on each.`,
    "",
    "## Paid endpoints",
    "",
    `The ${paidCount} endpoints marked "Paid" above cost ${PRO_PRICE_USD} in USDC per call over x402 on ${pay.network}. An unpaid request answers 402 with the amount, asset, network and recipient; sign the authorization and retry the same URL. Settlement happens only after a successful response, so a failed call is never charged.`,
    "",
    "## Read this before using the data",
    "",
    ...V1_CAVEATS.map((c) => `- **${c.title}.** ${c.body}`),
    "",
    "## Listed stocks",
    "",
    "Identity is the contract address; tickers are accepted by the API for convenience. Stocks Coinbase lists later are discovered onchain and appear in `/api/v1/stocks` without a change here.",
    "",
    ...CURATED_B20_ASSETS.map((a) => `- ${a.underlying}: ${a.address} ([page](${base}/stocks/${a.address}), [API](${base}/api/v1/stocks/${a.underlying}))`),
    "",
    "## About the app",
    "",
    `- [How it works](${base}/how-it-works): what the product does, in plain words.`,
    `- [Technical docs](${base}/docs): the B20 standard, price model, routing, limit orders, gift escrow and contract addresses.`,
    `- [Technical reference](${base}/docs/reference): the full reference, generated from the repository's HOW_IT_WORKS.md.`,
    `- [Status](${base}/status): live checks of every dependency.`,
    "",
    "Coinbase tokenized stocks are available only to eligible persons outside the United States. The API reports public chain data and builds calls for the user's own wallet; it never signs, sends or executes a trade.",
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400", "access-control-allow-origin": "*" },
  });
}
