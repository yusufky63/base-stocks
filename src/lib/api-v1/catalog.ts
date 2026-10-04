/**
 * One description of the public API, read by the index route, the OpenAPI document, the
 * developers page, `llms.txt` and `llms-full.txt`. Adding an endpoint in four places is how
 * documentation starts lying, so it is added here instead; `catalog.test.ts` checks this list
 * against the route files themselves.
 */

/**
 * Ten cents. One number, in one place, so the docs page and the routes cannot disagree.
 *
 * It lives here rather than beside the payment wiring so that a page which only writes about the
 * price does not have to pull `x402-next` in to read it; `x402.ts` imports it back from here.
 */
export const PRO_PRICE_USD = "$0.10";

export type V1Group = "market" | "wallet" | "trade" | "pro";

export const V1_GROUPS: Array<{ id: V1Group; title: string; intro: string }> = [
  { id: "market", title: "Market data", intro: "Prices, references, liquidity, headlines, yield venues and platform totals. Free, cached at the edge, open to every origin." },
  { id: "wallet", title: "Wallets", intro: "Any wallet's tokenized-stock position, read from the chain." },
  { id: "trade", title: "Trading", intro: "The calls to buy or sell a stock, built by the same router the app trades with. Nothing is signed or sent: the user's own wallet does that." },
  { id: "pro", title: "Paid", intro: `Two endpoints with a cost a cache cannot remove, priced at ${PRO_PRICE_USD} in USDC per call over x402.` },
];

export type V1ParamType = "string" | "integer" | "address" | "uint" | "enum" | "boolean";

export interface V1Param {
  name: string;
  in: "path" | "query" | "body";
  required: boolean;
  description: string;
  type?: V1ParamType;
  enum?: readonly string[];
  min?: number;
  max?: number;
  default?: string;
}

export interface V1Endpoint {
  /** Anchor on the developers page and the OpenAPI operationId. */
  id: string;
  method: "GET" | "POST";
  group: V1Group;
  path: string;
  /** Path with a real value substituted, so every example in the docs is one somebody can run. */
  example: string;
  /** For a POST: a body somebody can send as it is. */
  body?: Record<string, unknown>;
  summary: string;
  paid: boolean;
  cacheSeconds: number;
  params?: V1Param[];
  /** The shape of `data` in a 200, in one line. */
  returns: string;
  errors: string[];
  /** Requests a minute one caller may make, where the route keeps a window of its own. */
  limitPerMinute?: number;
  /** Answers 451 from a restricted country until the visitor confirms they are not a US person. */
  eligibility?: boolean;
}

/** A wallet that holds stocks, Earn and LP, so the examples return something to look at. */
const EXAMPLE_WALLET = "0xEAa823AB4C4eE00283d8ed7be713ddf8A5ba0Fac";

export const V1_ENDPOINTS: V1Endpoint[] = [
  {
    id: "stocks",
    method: "GET",
    group: "market",
    path: "/api/v1/stocks",
    example: "/api/v1/stocks",
    summary: "Every tokenized stock that can be traded right now (supply, a pool and a quote in both directions): DEX price, Chainlink reference where one exists, liquidity, 24h volume, multiplier and trading status.",
    paid: false,
    cacheSeconds: 30,
    returns: "{ count, stocks: Stock[] }",
    errors: [],
  },
  {
    id: "stock",
    method: "GET",
    group: "market",
    path: "/api/v1/stocks/{symbol}",
    example: "/api/v1/stocks/NVDA",
    summary: "One stock by ticker, token symbol or contract address, with the pools that trade it. Answers for any verified stock, including one that is not in the list above because it has no market yet.",
    paid: false,
    cacheSeconds: 30,
    params: [{ name: "symbol", in: "path", required: true, type: "string", description: 'Ticker ("NVDA"), token symbol ("NVDAc") or 0x address.' }],
    returns: "{ stock: Stock, pools: { address, name, dex, liquidityUsd, volume24hUsd, isPrimary, url }[] }",
    errors: ["404 UNKNOWN_STOCK"],
  },
  {
    id: "news",
    method: "GET",
    group: "market",
    path: "/api/v1/news",
    example: "/api/v1/news?scope=ecosystem&limit=5",
    summary: "Headlines: one stock's wire, the market desks, or the Base and Coinbase tokenized-stock feed. Titles and links only.",
    paid: false,
    cacheSeconds: 300,
    params: [
      { name: "scope", in: "query", required: false, type: "enum", enum: ["ecosystem", "market"], default: "ecosystem", description: "Which feed. Ignored when symbol is given." },
      { name: "symbol", in: "query", required: false, type: "string", description: "Ticker, for that stock's own headlines." },
      { name: "limit", in: "query", required: false, type: "integer", min: 1, max: 30, default: "10", description: "Headlines to return." },
    ],
    returns: "{ scope, symbol, count, items: { title, url, source, publishedAt, symbol, mentions }[] }",
    errors: ["400 BAD_SCOPE", "404 UNKNOWN_STOCK"],
  },
  {
    id: "earn",
    method: "GET",
    group: "market",
    path: "/api/v1/earn",
    example: "/api/v1/earn",
    summary: "Where idle USDC can earn on Base: venue, variable APY, TVL and risk notes, discovered live from the protocols.",
    paid: false,
    cacheSeconds: 120,
    returns: "{ asset, count, opportunities: Opportunity[], unavailableProviders }",
    errors: [],
  },
  {
    id: "stats",
    method: "GET",
    group: "market",
    path: "/api/v1/stats",
    example: "/api/v1/stats",
    summary: "What has been done through the app, counted from records verified against a receipt on Base.",
    paid: false,
    cacheSeconds: 300,
    returns: "{ generatedAt, windows, trading, strategies, gifts, earn }",
    errors: [],
  },
  {
    id: "portfolio",
    method: "GET",
    group: "wallet",
    path: "/api/v1/portfolio/{address}",
    example: `/api/v1/portfolio/${EXAMPLE_WALLET}`,
    summary: "Any wallet's tokenized-stock position, read from the chain — raw balances and share-equivalents side by side.",
    paid: false,
    cacheSeconds: 15,
    params: [{ name: "address", in: "path", required: true, type: "address", description: "0x-prefixed wallet address." }],
    returns: "{ owner, totalValueUsd, change24hPct, usdc, earnValueUsd, liquidityValueUsd, holdings: Holding[], readAt }",
    errors: ["400 BAD_ADDRESS", "429 RATE_LIMITED"],
    limitPerMinute: 60,
  },
  {
    id: "trade",
    method: "POST",
    group: "trade",
    path: "/api/v1/trade",
    example: "/api/v1/trade",
    body: { stock: "NVDA", side: "buy", amount: "10000000", account: EXAMPLE_WALLET },
    summary:
      "The calls to buy or sell one stock, for the account that will send them: an approval of exactly the amount sold when the allowance is short, then the swap, from the router the app trades with. Nothing is signed or sent.",
    paid: false,
    cacheSeconds: 0,
    params: [
      { name: "stock", in: "body", required: true, type: "string", description: 'Ticker ("NVDA"), token symbol ("NVDAc") or 0x address.' },
      { name: "side", in: "body", required: true, type: "enum", enum: ["buy", "sell"], description: "buy spends USDC (or ETH), sell spends the stock for USDC." },
      { name: "amount", in: "body", required: true, type: "uint", description: "What is sold, in its smallest unit: USDC has 6 decimals, ETH 18, a stock its own." },
      { name: "account", in: "body", required: true, type: "address", description: "The wallet that sends the calls and pays." },
      { name: "recipient", in: "body", required: false, type: "address", description: "Who receives a buy. Defaults to account; a sale always pays the account." },
      { name: "payWith", in: "body", required: false, type: "enum", enum: ["USDC", "ETH"], default: "USDC", description: "What a buy is paid with." },
      { name: "slippageBps", in: "body", required: false, type: "integer", min: 10, max: 500, default: "100", description: "How far below the quote the output may land, in basis points." },
      { name: "provider", in: "body", required: false, type: "enum", enum: ["zeroX", "kyber", "okx", "uniswap", "velora", "aerodrome"], description: "Try this route first; the others still cover a failure." },
      { name: "builderCode", in: "body", required: false, type: "string", description: "Your ERC-8021 builder code. It goes on every call beside the app's, so the trade is attributed to both." },
    ],
    returns: "{ stock, side, account, recipient, provider, quote, approval, calls: { to, data, value, description }[], quoteId, expiresAt }",
    errors: ["400 BAD_BODY", "404 UNKNOWN_STOCK", "409 NO_ROUTE", "429 RATE_LIMITED", "451 REGION_RESTRICTED", "4xx from the pre-trade checks", "502 TRADE_FAILED"],
    limitPerMinute: 30,
    eligibility: true,
  },
  {
    id: "report",
    method: "GET",
    group: "pro",
    path: "/api/v1/pro/report",
    example: "/api/v1/pro/report",
    summary: `The written market brief with the prices behind it. ${PRO_PRICE_USD} in USDC per call — it is backed by a model, so every call has a cost a cache cannot remove.`,
    paid: true,
    cacheSeconds: 900,
    returns: "{ report: { headline, summary, mood, marketOpen, perStock, ecosystem, themes, generatedAt }, stocks, disclaimer }",
    errors: ["402 PAYMENT_REQUIRED", "503 REPORT_UNAVAILABLE"],
  },
  {
    id: "history",
    method: "GET",
    group: "pro",
    path: "/api/v1/pro/history/{symbol}",
    example: "/api/v1/pro/history/NVDA?timeframe=1M",
    summary: `Full candle history for one stock, labelled with its source. ${PRO_PRICE_USD} in USDC per call.`,
    paid: true,
    cacheSeconds: 300,
    params: [
      { name: "symbol", in: "path", required: true, type: "string", description: "Ticker or 0x address." },
      { name: "timeframe", in: "query", required: false, type: "enum", enum: ["1D", "1W", "1M", "3M", "1Y"], default: "1M", description: "The span of the series." },
    ],
    returns: "{ symbol, address, timeframe, source, multiplier, count, candles }",
    errors: ["400 BAD_TIMEFRAME", "402 PAYMENT_REQUIRED", "404 UNKNOWN_STOCK"],
  },
];

/** The B20 rules a consumer has to encode or get wrong. Shown in the docs and in llms.txt. */
export const V1_CAVEATS = [
  {
    title: "One token is not one share",
    body: "Every stock carries a multiplier that moves on splits and dividends. Share-equivalents are rawBalance × multiplier ÷ 1e18. The portfolio endpoint returns both so no conversion is guessed.",
  },
  {
    title: "The Chainlink reference is a total-return value",
    body: "Coinbase's feeds report total return, not the raw equity price. It is returned as reference.totalReturnUsd, deliberately not named a price: comparing it with dexPriceUsd and calling the gap an arbitrage is a mistake.",
  },
  {
    title: "Feeds run 24/5 and then hold",
    body: "Outside US trading hours, and during a corporate action, a feed stops updating and keeps its last value while staying callable. Read reference.updatedAt and reference.isStale before relying on it.",
  },
  {
    title: "Not every stock has a reference",
    body: "A newer stock may have no Chainlink feed yet. Its reference is null, displaySource is \"market\" and displayUsd is the pool price with nothing to check it against. Read liquidityUsd and status before relying on it: a pool of a few thousand dollars moves with a single trade.",
  },
  {
    title: "A pool is not automatically a price",
    body: "dexPriceUsd is read only from a pool quoted in USDC or ETH, and only counts as displayUsd when it is within 20% of a live reference. A pool prices a token against whatever is on its other side, so a pair quoted in a long-tail token reports that token's valuation: one such pair had a stock reading 49x its reference. When the check refuses the market price, displaySource is \"reference\" even though dexPriceUsd is present.",
  },
  {
    title: "Identity is the address",
    body: "Names and symbols are mutable onchain metadata. Symbols are accepted for convenience, but store the address.",
  },
];

export function endpointsIn(group: V1Group): V1Endpoint[] {
  return V1_ENDPOINTS.filter((e) => e.group === group);
}

/**
 * The conventions every route follows, shown as the configuration table on the developers page
 * and in llms-full.txt. `base` is the deployment's own origin.
 */
export function apiRules(base: string): Array<{ label: string; text: string }> {
  return [
    { label: "Base URL", text: `${base}/api/v1 · JSON · Base mainnet (8453)` },
    { label: "Keys", text: "none · no account and no sign-up · the paid endpoints take an x402 payment instead of a key" },
    { label: "CORS", text: "open to every origin, GET and POST · a browser on any site may call it" },
    { label: "Envelope", text: "{ data, meta } · meta.cacheSeconds says how long the body stays valid, and the CDN honours the same number" },
    { label: "Errors", text: "{ error: { code, message, hint? } } with a 4xx or 5xx status · 402 carries the x402 payment requirements · 451 means the eligibility answer is missing" },
    { label: "Amounts", text: "integer strings in the smallest unit: USDC has 6 decimals, ETH 18; a stock token carries a multiplier, so read shares from the API rather than dividing yourself" },
    { label: "Identity", text: "a stock is its contract address; tickers and symbols are accepted and resolved to it" },
    { label: "Signing", text: "never on the server · /api/v1/trade returns calls for the user's own wallet, which signs and sends them" },
    { label: "Eligibility", text: "from a restricted country, /api/v1/trade answers 451 until the visitor confirms they are not a US person; a site that asks in its own UI sends x-bstocks-eligibility: confirmed, never on the visitor's behalf" },
  ];
}
