# Roadmap

Gap analysis against the two source documents (the Integration Guide "Base Tokenized Stocks — Trading, Liquidity, Market Data & Earn" and PROJECT_SPEC) plus the state of the live deployment, reviewed 2026-09-03 at commit `d470a04`. Everything below is optional; the product works without it. Dates are decision dates.

## Where we stand (2026-09-03)

Done and live at https://basestocks.finance: 13 B20 stocks by canonical address with onchain discovery (`B20Created` + Chainlink directory + admin verification), keyless market data (DexScreener → GeckoTerminal, CoinGecko optional), Chainlink reference with staleness, six parallel trade routes scored on net output after gas (KyberSwap, Velora, Uniswap Trading API, Aerodrome direct, OKX DEX v6, CoW Protocol signed orders; 0x when the asset is authorized), limit orders through CoW, B20Guard (policies, pauses, oracle), simulation on the sequential path, atomic batches + paymaster + ERC-8021 Builder Code on Base Account, Flashblocks preconfirmation, portfolio with scaled balances / partial fills / rebalance, baskets + AI drafts, gifts with `transferWithMemo` and Basenames, USDC Earn (Morpho, Aave, Compound) with runtime discovery, LP position tracking, SIWE sessions, geoblock attest/block, status page, Vercel cron. 51 unit tests, typecheck clean.

Deployment findings: `/api/health` ok, `/api/status` was degraded only because of OKX (50125); resolved the same day with a new key and the v6 API. Locally `AUTH_SECRET`, `ADMIN_API_TOKEN` and `GEOBLOCK_MODE` are unset; confirm they are set on Vercel (without `AUTH_SECRET` sessions reset on every cold start; without `ADMIN_API_TOKEN` `/admin` is unusable).

## Phase A — Production hardening (next)

- **Vercel env check**: `AUTH_SECRET`, `ADMIN_API_TOKEN`, `CRON_SECRET`, `NEXT_PUBLIC_APP_URL=https://basestocks.finance`, `GEOBLOCK_MODE`. 0x reports "enabled for tokenized stocks" in production; the 0x opt-in terms require blocking US traffic, so either set `GEOBLOCK_MODE=block` or keep 0x off for US requests.
- **Durable rate limiting and quotas**: `src/lib/rate-limit.ts` and the AI quota are per-instance memory; on serverless they reset per cold start. Move to Supabase (or Upstash) counters.
- **Cron cadence**: `vercel.json` runs discovery + status once a day (05:00). The guide asks for discovery every 10–30 min; on a paid Vercel plan raise the schedule, or split status probes to their own cron.
- **Spec gaps in the trade flow**: show the firm quote in the review sheet (not only the indicative), run simulation on the batched (`sendCalls`) path too, surface MINT/BURN pause on the stock page.
- **E2E smoke tests** (Playwright against `next dev`): anonymous browse, connect, price → review, build a basket, send to Basename, Earn hidden when unsupported, mobile trade sheet. Also unit tests for `trade-router` scoring and the Earn adapters.
- **Error monitoring** beyond `/status`: Sentry or Vercel Observability on API routes, with provider latency/fallback counters exported.
- **Base app submission**: sign `accountAssociation` and set `baseBuilder.allowedAddresses` in `public/.well-known/farcaster.json`.
- **Legal**: choose a license file; legal review of the eligibility notice and issuer disclosures before promotion.

## Phase B — Execution depth

- **CoW Protocol** shipped 2026-09-03 as the sixth route (signed orders, solver-paid gas) plus limit orders and a "Your orders" module. Still open: ETH Flow (pay with native ETH through CoW), permit-based approvals via CoW hooks so a buy needs no transaction at all, and a "best execution" size threshold that prefers CoW automatically for large orders.
- **Quote scoring**: include the 0x integrator fee and price impact in `netUsd`, not only the network fee; show "Best price found" with the provider behind a disclosure.
- **Trade API tests**: schema tests for Kyber, Velora, Uniswap responses like the existing 0x ones.

## Phase C — Liquidity and Earn

- **LP Phase 2: add and manage liquidity in-app** (deferred 2026-09-03). Aerodrome Slipstream and Uniswap v3 position managers: exact approvals for both tokens, `mint` from a USD price range (tick math in `src/lib/earn/lp-math.ts`; missing the inverse "amounts for a range"), `increaseLiquidity`, `decreaseLiquidity` + `collect`. Preview shows range in USD per share, both amounts, position value; simulate before signing. Uniswap v4 stays on the venue.
- **LP Phase 3**: stake Slipstream positions in the gauge for AERO emissions; unstake before removing.
- **KyberSwap Earn / Zap**: single-token entry into concentrated pools.
- **Beefy and Euler discovery** for the Earn scan if they ever list tokenized stocks.
- **Morpho borrow**: `supplyCollateral` + `borrow`, health factor, repay/withdraw — only once a Morpho market lists a B20 token as collateral (none today; discovery would show it).

## Phase D — Automation

- **Server-side executor** for due plans: today rules are stored and `isDue()` is computed, but nothing runs without the user (`src/services/automation-service.ts`, no cron). Needs a queue, idempotent runs, and execution records in `portfolio_executions`.
- **Base Account Spend Permissions**: daily cap, expiry, listed stocks only; separate safety review. Default stays "system proposes → user approves".
- **Drift alerts UI** and rebalance suggestions as notifications.
- **Sub Accounts** for app-scoped execution once the executor exists.

## Phase E — Reach

- **LI.FI SDK / widget in-app** instead of the hosted jumper.exchange link (heavy dependency; the link already covers 20+ chains).
- **Claimable gifts** (`GiftEscrow`) for recipients without a wallet — only if the claim-link flow is approved.
- **CoinGecko Onchain (paid)** as primary market data once public rate limits bind; the adapter already exists behind `COINGECKO_API_KEY`.
- **More issuers** (Dinari, xStocks) behind the existing `issuer` field and verification state — never merged blindly with Coinbase B20.

## Dropped

- **1inch** — needs an authenticated API key; not worth it while KyberSwap, Uniswap and Velora cover the same pools.
- **Coinbase Onramp** — not integrated by decision (2026-09-03); "From Coinbase" means withdrawing USDC on Base to the shown address.
- **Market trades tape** on the stock page — removed 2026-09-03; "Your trades" stays.
