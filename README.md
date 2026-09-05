# BStocks

A self-custodial interface for **Coinbase Tokenized Stocks on Base** (the B20 standard). Live prices and charts, best-route trading across several DEX aggregators, baskets and recurring plans, yield discovery, gifting stock to a Basename or a whole group at once, and a fenced AI assistant — all without holding keys or funds.

> Coinbase Tokenized Stocks are available only to eligible persons outside the United States. BStocks is an independent interface built on Base, not an official Base or Coinbase product, and does not provide investment advice.

## What it does

| Area | Highlights |
| --- | --- |
| Markets | 13 stocks with live DEX price, Chainlink reference and freshness, candles and volume, a Live / Thin / Very thin / No pool / Not issued status, single Buy action |
| Trade | Every quote asks KyberSwap, Velora, the Uniswap Trading API, Aerodrome directly, CoW Protocol and, when enabled, 0x and OKX; you pick auto (best net output) or a provider. Pay with USDC or ETH. Exact approvals, simulation before signing, atomic batches on Base Account. CoW orders are signed, not sent: solvers pay the gas. Limit orders at your own price, cancellable any time |
| Strategies | Build baskets (sliders, templates, guided AI drafts with live market context), community baskets with votes and clones, and **auto-invest**: a stock or a basket bought on a schedule by the AutoInvest contract — amount, cadence, routes and minimum output enforced onchain, cancel or revoke any time — or, if you prefer, a plan that waits for your confirmation per run |
| Earn | Idle USDC into Morpho vaults, Aave V3 and Compound v3 from the app; stock pools, LP positions and lending venues discovered at runtime, never hardcoded |
| Portfolio | Value (stocks + USDC + Earn + LP), allocation, history, profit and loss, rebalance against a template or your own saved target (one drift measure for the banner, the table and the trades), verified activity, daily AI summary and badges |
| Send & gift | To a Basename or address with the recipient's profile shown first, or a claim link for someone without a wallet: the stock waits in an ownerless escrow, they claim it with a passkey Base Account and the gas is sponsored. Public receipt pages to share |
| Gift pools | One deposit, many equal shares of one stock or a package of several: a share link, a public directory or steps to finish first. Onchain steps (a Basename, a holding, a verified purchase) are read from Base; X steps are recorded as the claimant's own confirmation and labelled that way. Close a pool any time — or lock it so you cannot — and the unclaimed remainder comes home |
| News | Headlines per stock and market-wide, a Base & Coinbase feed that follows tokenized-stock listings and venues, and one shared AI brief every six hours that reads ~60 headlines and leads with that ecosystem; the same brief and headlines ground the basket and plan drafts, which come with a "why this mix" commentary |
| Compliance | Eligibility notice for restricted regions (`attest` or `block` mode), issuer policies and pauses read before every action |
| Stats | `/stats`: trades, volume, wallets, gifts, pools, Earn and plan runs, every figure verified against its receipt on Base; a six-figure summary and an anonymous public feed on the home page |
| Status | Live, smoothed checks of every dependency at `/status` |

The narrative and FAQ live in the app at `/how-it-works`. The technical reference (contracts, data sources, providers, environment, routes) is [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md); the backlog is [docs/ROADMAP.md](docs/ROADMAP.md).

## Also in the box

- **Installable**: a web app manifest with maskable icons and shortcuts; add BStocks to a phone or desktop and it opens in its own window. No service worker, so no stale prices from a cache.
- **Printable gift cards**: every gift link, bulk link and pool link prints as a QR card (four to an A4 sheet), drawn in the browser — the link never reaches a server.
- **Public feed**: the latest verified transactions, with no wallet named, on Home and on Activity for visitors without a wallet; the same shared-cached object as the counters and `/stats`.
- **Heatmap view**: Markets can be read as tiles instead of a list, each stock coloured by its 24h move with the three deepest markets doubled; the choice is remembered.
- **Benchmark**: the equal-weight index of the listed stocks runs dashed behind the portfolio's value history, one shared-cached series per window.
- **Market clock and premium meter**: the ticker says whether the NYSE is open and when that changes; every stock page shows how far the pool price sits from the Chainlink reference.
- **Gift a basket**: any template or basket becomes a one-share package, claimable with a link, from the stocks you hold.
- **Statistics that stay cheap**: finished days are rolled up once and stored; `/stats` reads the recent days and the rollups, so it costs the same at ten thousand records as at a hundred.
- **An integrator fee, off by default**: set a rate and a recipient and KyberSwap, CoW and 0x routes carry it, shown on the quote and summed on `/stats`.
- **Return to target on a schedule**: a buy-only manual plan from the Rebalance tab, legs computed from live holdings on each run, confirmed in the wallet, never automatic, never a sell.

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript strict · Tailwind 4 · Wagmi 3 / Viem 2 · Reown AppKit · Base Account · TanStack Query · Zod · Lightweight Charts · Supabase (optional) · Vitest.

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Without any keys the app still runs: assets, multipliers, pause flags, policies and Chainlink reference prices come straight from Base; DEX prices, liquidity, pools and candles come from the keyless DexScreener and GeckoTerminal APIs behind a shared server-side cache; trades route through KyberSwap, Velora and Aerodrome. Keys add providers and features:

| Variable | Adds |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AUTH_SECRET` | Persistence (records, profiles, plans, briefs) and sign-in; without them an in-memory store is used |
| `NEXT_PUBLIC_REOWN_PROJECT_ID` | Wallet modal and card/bank onramp providers |
| `NEXT_PUBLIC_PAYMASTER_URL` | Sponsored gas for Base Account batches |
| `UNISWAP_API_KEY`, `ZEROX_API_KEY`, `OKX_API_KEY` + `OKX_SECRET_KEY` + `OKX_PASSPHRASE` | Additional trade routes in the comparison |
| `AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` (or `ANTHROPIC_API_KEY`), `AI_MONTHLY_BUDGET_USD` | The assistant: basket and plan drafts, market and portfolio briefs |
| `GEOBLOCK_COUNTRIES`, `GEOBLOCK_MODE` | Compliance: which countries see the eligibility notice, and whether they may self-certify |
| `NEXT_PUBLIC_BASE_BUILDER_CODE` | ERC-8021 attribution on every transaction |
| `NEXT_PUBLIC_GIFT_POOL_ADDRESS` | Gift pools; unset hides the feature entirely |
| `POOL_GATE_SIGNER_KEY` | Steps in front of a gift pool; without it, link and open pools still work |
| `NEXT_PUBLIC_AUTO_INVEST_ADDRESS`, `AUTOMATION_KEEPER_KEY` | Auto-invest: the deployed AutoInvest contract and the keeper that runs due plans ([docs/AUTO_INVEST.md](docs/AUTO_INVEST.md)); without them plans are confirmed by hand |
| `ADMIN_API_TOKEN` | The `/admin` page: verifying newly discovered tokens, recent errors, health alerts |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | A Redis shared-cache tier across serverless instances (optional; the `kv_cache` table is used otherwise) |

The full list with explanations is in [.env.example](.env.example). Apply the database schema to a Supabase project with `pnpm db:apply` (see the script in `scripts/db-apply.mjs`) or through the Supabase MCP.

## Scripts

```bash
pnpm dev            # Next dev server on :3000
pnpm build          # production build
pnpm start          # serve the build
pnpm exec tsc --noEmit
pnpm exec eslint src
pnpm exec vitest run
```

`scripts/verify-*.mjs` are the onchain and API checks used while building (B20 spec, issuance, policies, Aerodrome and Uniswap pools, Earn venues, LP managers). They read `.env` and print facts; none of them sends a transaction.

## Deploying on Vercel

1. Import the repository; framework preset **Next.js**, Node 22, install with `pnpm install`.
2. Add the environment variables from the table above (server variables stay server-only; only `NEXT_PUBLIC_*` reach the browser).
3. Vercel supplies `x-vercel-ip-country`, which the proxy uses for the eligibility notice; set `GEOBLOCK_MODE=block` if you later enable 0x for US traffic.
4. Set `NEXT_PUBLIC_APP_URL` to the deployed origin (wallet modal metadata and share links) and `CRON_SECRET` to a random 32+ character string: `vercel.json` schedules `/api/cron/refresh` (light discovery scan + status probes) because in-process timers do not survive on serverless.
5. The in-process cache is per instance; that is fine for a single region. Persistent state (records, briefs, quotas, discovered assets) lives in Supabase.
6. Base app: `public/.well-known/farcaster.json` is the mini app manifest (icon and splash are generated PNG routes, share card is `/opengraph-image`). Add your Base Build account address to `baseBuilder.allowedAddresses` and sign `accountAssociation` from Base Build before submitting.

## Safety model

- Self-custodial: no keys, no funds, no signature on page load.
- Only verified assets from the canonical registry are tradable; new B20 tokens must come from Coinbase's deployer and carry a Chainlink feed.
- A record counts only once the server has matched it to the chain: a trade's receipt must show the stock arriving in the wallet it names, a gift the escrow's own event, a pool claim its `PoolClaimed` log. Records the receipt contradicts are never shown or counted.
- Quotes and every provider key stay server-side; approvals are limited to the exact amount and the spender the provider returns; every transaction is simulated first.
- The assistant only knows the listed tickers and live market context, never sees addresses or calldata, cannot execute anything, and is rate- and budget-limited.
- Headlines, RSS and model output are treated as data, never as instructions.

## License

No license has been chosen yet; all rights reserved until one is added.
