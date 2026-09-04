# Roadmap

Gap analysis against the two source documents (the Integration Guide "Base Tokenized Stocks — Trading, Liquidity, Market Data & Earn" and PROJECT_SPEC) plus the state of the live deployment, reviewed 2026-09-03 at commit `d470a04`. Everything below is optional; the product works without it. Dates are decision dates.

## Where we stand (2026-09-03)

Done and live at https://basestocks.finance: 13 B20 stocks by canonical address with onchain discovery (`B20Created` + Chainlink directory + admin verification), keyless market data (DexScreener → GeckoTerminal, CoinGecko optional), Chainlink reference with staleness, six parallel trade routes scored on net output after gas (KyberSwap, Velora, Uniswap Trading API, Aerodrome direct, OKX DEX v6, CoW Protocol signed orders; 0x when the asset is authorized), limit orders through CoW, B20Guard (policies, pauses, oracle), simulation on the sequential path, atomic batches + paymaster + ERC-8021 Builder Code on Base Account, Flashblocks preconfirmation, portfolio with scaled balances / partial fills / rebalance, baskets + AI drafts, gifts with `transferWithMemo` and Basenames, USDC Earn (Morpho, Aave, Compound) with runtime discovery, LP position tracking, SIWE sessions, geoblock attest/block, status page, Vercel cron. 51 unit tests, typecheck clean.

Deployment findings: `/api/health` ok, `/api/status` was degraded only because of OKX (50125); resolved the same day with a new key and the v6 API. Locally `AUTH_SECRET`, `ADMIN_API_TOKEN` and `GEOBLOCK_MODE` are unset; confirm they are set on Vercel (without `AUTH_SECRET` sessions reset on every cold start; without `ADMIN_API_TOKEN` `/admin` is unusable).

## Phase A — Production hardening (next)

- **Vercel env check**: `AUTH_SECRET`, `ADMIN_API_TOKEN`, `CRON_SECRET`, `NEXT_PUBLIC_APP_URL=https://basestocks.finance`, `GEOBLOCK_MODE`. 0x reports "enabled for tokenized stocks" in production; the 0x opt-in terms require blocking US traffic, so either set `GEOBLOCK_MODE=block` or keep 0x off for US requests.
- **Durable rate limiting** shipped 2026-09-03: write/model routes layer a shared Supabase window counter (reusing the atomic `ai_usage` increment) over the in-memory bucket; the daily cron sweeps expired rows. (The AI quota was already durable.) Read-heavy routes stay memory-only by design.
- **Discovery cadence** solved without a paid cron 2026-09-03: `/api/assets` schedules a light `B20Created` scan after the response (Next `after()`), at most every 30 min per instance; the daily cron keeps the deep scan.
- **Trade-flow spec gaps** closed 2026-09-03: the review sheet fetches, shows and signs the firm quote, and the batched path runs an `eth_simulateV1` bundle check. Still open: surface MINT/BURN pause on the stock page.
- **Tests** landed 2026-09-03: `pnpm e2e` runs an 8-test anonymous Playwright smoke; vitest covers trade-router scoring and LP math; the escrow has 4 fuzz properties. Still open: wallet-connected e2e flows and provider schema tests for Kyber/Velora/Uniswap.
- **Error monitoring** beyond `/status`: Sentry or Vercel Observability on API routes, with provider latency/fallback counters exported.
- **Base app submission**: sign `accountAssociation` and set `baseBuilder.allowedAddresses` in `public/.well-known/farcaster.json`.
- **Legal**: choose a license file; legal review of the eligibility notice and issuer disclosures before promotion.

## Phase B — Execution depth

- **CoW Protocol** shipped 2026-09-03 as the sixth route (signed orders, solver-paid gas) plus limit orders and a "Your orders" module. Still open: ETH Flow (pay with native ETH through CoW), permit-based approvals via CoW hooks so a buy needs no transaction at all, and a "best execution" size threshold that prefers CoW automatically for large orders.
- **Quote scoring**: include the 0x integrator fee and price impact in `netUsd`, not only the network fee; show "Best price found" with the provider behind a disclosure.
- **Trade API tests**: schema tests for Kyber, Velora, Uniswap responses like the existing 0x ones.

## Denim hardfork watch (added 2026-09-04)

Base plans to replace Flashblocks with canonical 200ms blocks in the Denim hardfork (live on Vibenet only; Sepolia/Mainnet activation TBD). Codebase inventory against the official migration table came back clean: no `"pending"` block-tag reads, no `eth_subscribe` / WebSocket use anywhere — our only Flashblocks consumption is plain `getTransactionReceipt` against the Flashblocks-aware HTTP endpoint in confirmation-service, which keeps working unchanged (receipts just become canonical instead of preconfirmed). Denim-ready refactor applied 2026-09-04: the confirmation path is now cadence-neutral (`getFastReceiptClient` hardcodes mainnet.base.org; `FLASHBLOCKS_RPC_URL` env removed; docs copy era-proofed) and needs no change at activation. Post-activation leftovers, cosmetic only: collapse "preconfirmed" into "confirmed" wording; optionally adopt the new `timestampMs` response fields for sub-second activity timestamps.

## Phase C — Liquidity and Earn

- **LP Phase 2 shipped 2026-09-03**: collect fees and withdraw 25–100% (decrease + collect) plus in-app `mint` from a USD-per-share range (±5/10/25% or full, inverse amounts-for-range math with tests, exact approvals, simulated bundle, 1% minimums) on USDC-quoted Uniswap v3 and Slipstream pools — all atomic on Base Account. Still open: `increaseLiquidity` (near-free now), WETH-quoted pools, Uniswap v4 stays on the venue.
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

- **GiftEscrow shipped 2026-09-03** (`0x8D9fE4b3Ab9BecbE1181d15d51FB9724561C7f55`, `contracts/`, 17 Foundry tests): claim-link gifts with passkey onboarding and sponsored claims. Source verified on Basescan (2026-09-03). Still open: add the escrow's `claim` to the CDP paymaster allowlist so no-ETH recipients are actually sponsored, and a first real mainnet run (create → claim → cancel with a few dollars of stock).

- **LI.FI SDK / widget in-app** instead of the hosted jumper.exchange link (heavy dependency; the link already covers 20+ chains).
- **CoinGecko Onchain (paid)** as primary market data once public rate limits bind; the adapter already exists behind `COINGECKO_API_KEY`.
- **More issuers** (Dinari, xStocks) behind the existing `issuer` field and verification state — never merged blindly with Coinbase B20.

## Dropped

- **1inch** — needs an authenticated API key; not worth it while KyberSwap, Uniswap and Velora cover the same pools.
- **Coinbase Onramp** — not integrated by decision (2026-09-03); "From Coinbase" means withdrawing USDC on Base to the shown address.
- **Market trades tape** on the stock page — removed 2026-09-03; "Your trades" stays.
