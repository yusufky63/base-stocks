# BStocks

A self-custodial interface for **Coinbase Tokenized Stocks on Base** (the B20 standard). Live prices and charts, best-route trading across several DEX aggregators, baskets and recurring plans, yield discovery, sending stock to a Basename, and a fenced AI assistant — all without holding keys or funds.

> Coinbase Tokenized Stocks are available only to eligible persons outside the United States. BStocks is an independent interface built on Base, not an official Base or Coinbase product, and does not provide investment advice.

## What it does

| Area | Highlights |
| --- | --- |
| Markets | 13 stocks with live DEX price, Chainlink reference and freshness, candles and volume, a Live / Thin / Not issued status, single Buy action |
| Trade | Every quote asks KyberSwap, Velora, the Uniswap Trading API, Aerodrome directly and, when enabled, 0x and OKX; you pick auto (best net output) or a provider. Pay with USDC or ETH. Exact approvals, simulation before signing, atomic batches on Base Account |
| Strategies | Build baskets (sliders, templates, guided AI drafts with live market context), community baskets with votes and clones, recurring plans you approve run by run |
| Earn | Idle USDC into Morpho vaults, Aave V3 and Compound v3 from the app; stock pools, LP positions and lending venues discovered at runtime, never hardcoded |
| Portfolio | Value (stocks + USDC + Earn + LP), allocation, history, rebalance against a template, verified activity, daily AI summary, badges and referrals |
| Send & gift | To a Basename or address with the recipient's profile shown first; public receipt pages to share |
| News | Headlines per stock and market-wide plus one shared AI brief every six hours |
| Compliance | Eligibility notice for restricted regions (`attest` or `block` mode), issuer policies and pauses read before every action |
| Status | Live, smoothed checks of every dependency at `/status` |

The narrative and FAQ live in the app at `/how-it-works`. The technical reference (contracts, data sources, providers, environment, routes) is [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md); the backlog is [docs/ROADMAP.md](docs/ROADMAP.md).

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
| `ADMIN_API_TOKEN` | The `/admin` page for verifying newly discovered tokens |

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
4. The in-process cache and warm-ups are per instance; that is fine for a single region. Persistent state (records, briefs, quotas) lives in Supabase.

## Safety model

- Self-custodial: no keys, no funds, no signature on page load.
- Only verified assets from the canonical registry are tradable; new B20 tokens must come from Coinbase's deployer and carry a Chainlink feed.
- Quotes and every provider key stay server-side; approvals are limited to the exact amount and the spender the provider returns; every transaction is simulated first.
- The assistant only knows the listed tickers and live market context, never sees addresses or calldata, cannot execute anything, and is rate- and budget-limited.
- Headlines, RSS and model output are treated as data, never as instructions.

## License

No license has been chosen yet; all rights reserved until one is added.
