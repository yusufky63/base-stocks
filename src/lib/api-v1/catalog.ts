/**
 * One description of the public API, read by the index route, the OpenAPI document, the
 * developers page and `llms.txt`. Adding an endpoint in four places is how documentation starts
 * lying, so it is added here instead.
 */

/**
 * Ten cents. One number, in one place, so the docs page and the routes cannot disagree.
 *
 * It lives here rather than beside the payment wiring so that a page which only writes about the
 * price does not have to pull `x402-next` in to read it; `x402.ts` imports it back from here.
 */
export const PRO_PRICE_USD = "$0.10";
export interface V1Endpoint {
  path: string;
  /** Path with a real value substituted, so every example in the docs is one somebody can run. */
  example: string;
  summary: string;
  paid: boolean;
  cacheSeconds: number;
  params?: Array<{ name: string; in: "path" | "query"; required: boolean; description: string }>;
}

export const V1_ENDPOINTS: V1Endpoint[] = [
  {
    path: "/api/v1/stocks",
    example: "/api/v1/stocks",
    summary: "Every listed tokenized stock: DEX price, Chainlink reference, liquidity, 24h volume, multiplier and trading status.",
    paid: false,
    cacheSeconds: 30,
  },
  {
    path: "/api/v1/stocks/{symbol}",
    example: "/api/v1/stocks/NVDA",
    summary: "One stock by ticker, token symbol or contract address, with the pools that trade it.",
    paid: false,
    cacheSeconds: 30,
    params: [{ name: "symbol", in: "path", required: true, description: 'Ticker ("NVDA"), token symbol ("NVDAc") or 0x address.' }],
  },
  {
    path: "/api/v1/news",
    example: "/api/v1/news?scope=ecosystem&limit=5",
    summary: "Headlines: one stock's wire, the market desks, or the Base and Coinbase tokenized-stock feed. Titles and links only.",
    paid: false,
    cacheSeconds: 300,
    params: [
      { name: "scope", in: "query", required: false, description: '"ecosystem" (default) or "market". Ignored when symbol is given.' },
      { name: "symbol", in: "query", required: false, description: "Ticker, for that stock's own headlines." },
      { name: "limit", in: "query", required: false, description: "1–30, default 10." },
    ],
  },
  {
    path: "/api/v1/earn",
    example: "/api/v1/earn",
    summary: "Where idle USDC can earn on Base: venue, variable APY, TVL and risk notes, discovered live from the protocols.",
    paid: false,
    cacheSeconds: 120,
  },
  {
    path: "/api/v1/portfolio/{address}",
    // A wallet that actually holds stocks, Earn and LP, so the example on the docs page returns
    // something to look at rather than an honest but useless row of zeros.
    example: "/api/v1/portfolio/0xEAa823AB4C4eE00283d8ed7be713ddf8A5ba0Fac",
    summary: "Any wallet's tokenized-stock position, read from the chain — raw balances and share-equivalents side by side.",
    paid: false,
    cacheSeconds: 15,
    params: [{ name: "address", in: "path", required: true, description: "0x-prefixed wallet address." }],
  },
  {
    path: "/api/v1/stats",
    example: "/api/v1/stats",
    summary: "What has been done through the app, counted from records verified against a receipt on Base.",
    paid: false,
    cacheSeconds: 300,
  },
  {
    path: "/api/v1/pro/report",
    example: "/api/v1/pro/report",
    summary: `The written market brief with the prices behind it. ${PRO_PRICE_USD} in USDC per call — it is backed by a model, so every call has a cost a cache cannot remove.`,
    paid: true,
    cacheSeconds: 900,
  },
  {
    path: "/api/v1/pro/history/{symbol}",
    example: "/api/v1/pro/history/NVDA?timeframe=1M",
    summary: `Full candle history for one stock, labelled with its source. ${PRO_PRICE_USD} in USDC per call.`,
    paid: true,
    cacheSeconds: 300,
    params: [
      { name: "symbol", in: "path", required: true, description: "Ticker or 0x address." },
      { name: "timeframe", in: "query", required: false, description: "1D, 1W, 1M (default), 3M or 1Y." },
    ],
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
    title: "Identity is the address",
    body: "Names and symbols are mutable onchain metadata. Symbols are accepted for convenience, but store the address.",
  },
];
