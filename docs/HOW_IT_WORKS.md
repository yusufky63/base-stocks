# BStocks — technical reference

BStocks is a self-custodial consumer interface for **Coinbase Tokenized Stocks on Base** (the B20 standard). It shows prices, routes trades through DEX aggregators, builds and automates baskets, discovers yield venues, sends stock to Basenames, and explains everything it does. It never holds keys or funds, never signs on page load, and treats every external text (headlines, RSS, model output) as data, not instructions.

This document is the technical reference. The product narrative and FAQ are on the in-app page `/how-it-works`; the backlog is in [ROADMAP.md](./ROADMAP.md).

---

## 1. Feature map

| Area | Route | What it does |
| --- | --- | --- |
| Home | `/` | Quick buy (live stocks first), movers, news brief, portfolio summary, ticker rows (prices on by default, headlines opt-in). |
| Markets | `/markets` | All 13 stocks with status chip (Live / Thin / No pool / Not issued / Paused), sparkline, price, 24h, Chainlink reference, single Buy action. Region notice for restricted visitors. |
| Stock | `/stocks/[address]` | Price header with freshness, candles + volume with zoom, trade panel (USDC or ETH, route picker, gift mode), tabs: Your position (+ LP line, your trades), Earn or borrow, Details (contract, oracle, liquidity map). |
| Strategies | `/build`, `/community`, `/automate` | One section with three routed tabs: Build (guided AI draft, allocation editor, plan preview, templates, publish), Community (7-day pulse, published baskets, votes, clones), Automate (plans you approve, guided or AI-drafted). Template pages live under `/build/[slug]`, community baskets under `/baskets/[id]`. |
| Earn | `/earn` | Idle-USDC venues executed in-app (Morpho vaults, Aave V3, Compound v3), your liquidity positions, stock-specific venues with type filters and an honest scan note. |
| Portfolio | `/portfolio` | Value (stocks + USDC + Earn + LP), allocation, history, daily AI summary, gift inbox, automation card, Earn card; tabs Rebalance, Activity, Profile (handle, bio, visibility, badges with progress, referrals). |
| Public profile | `/u/[handle-or-address]` | Allocation in percent (if public), badges, published baskets, referral counters. |
| Gift receipt | `/gifts/[id]` | Public page for a submitted gift: from, to, amount, message, tx proof, share. |
| News | `/news` | Headlines per stock and market-wide, "Today's brief" (shared AI summary every 6 h). |
| Settings | `/settings` | Slippage, ticker rows, motion, diagnostics (providers, geoblock mode, storage backend). |
| Status | `/status` | Live probes of every dependency. |
| How it works | `/how-it-works` | Narrative, safety model, fees, FAQ. |
| Admin | `/admin` | Verification of newly discovered B20 tokens (admin token). |

---

## 2. Architecture

- **Next.js 16 (App Router, Turbopack), React 19, TypeScript strict, Tailwind 4, pnpm, Vitest.** Server code lives in `src/services` (orchestration), `src/providers` (one adapter per external system), `src/domain` (types and pure rules), `src/db` (repositories with a memory backend and a Supabase backend), `src/lib` (cache, HTTP, rate gate, fallback racing, AI provider, quotas, math). UI lives in `src/components`, pages in `src/app`, route handlers in `src/app/api`.
- **Caching.** `src/lib/cache.ts` is an in-process TTL + stale-while-revalidate cache keyed per resource; one upstream request serves every visitor for a window. `src/lib/rate-gate.ts` serialises calls to keyless APIs (GeckoTerminal ≈ 30 req/min). `src/lib/http.ts` provides `fetchJson`, per-provider circuit breakers and a metrics registry surfaced on `/api/health` and `/status`.
- **Hedged fallback.** `src/lib/fallback.ts` races a primary provider against a fallback chain with a short hedge delay; used for firm quotes.
- **Warm-up.** `src/instrumentation.ts` refreshes assets/prices at boot, runs B20 discovery (boot: 450k blocks, then every 30 min: 60k), and probes 0x hourly — on long-running Node. On Vercel (`VERCEL` set) it only loads the stored registry; `vercel.json` schedules `/api/cron/refresh` (Bearer `CRON_SECRET`) for the light discovery scan and status probes.
- **Proxy.** `src/proxy.ts` captures `?ref=<address>` into an HttpOnly cookie (30 days) and enforces the geoblock on execution routes (`/api/trade/*`, `/api/earn/prepare`, `/api/portfolio/(plan|quote|execute)`).
- **Storage.** Supabase (service role, server-side only) when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, otherwise in-memory repositories with the same interfaces. Every Supabase repo is wrapped in `resilient()` so a storage outage degrades to defaults instead of failing pages.

---

## 3. Onchain facts (Base mainnet, verified 2026-09-02/03)

### 3.1 B20 tokens (Coinbase Tokenized Stocks)

Identity is the **contract address**; symbols end in `c`. `decimals = 8`. `scaledBalanceOf` returns share-equivalents (`raw × multiplier / 1e18`); the UI always shows share-equivalents.

| Ticker | Contract | Issued |
| --- | --- | --- |
| AAPLc | `0xb200000000000000000000C2e324d24d7eEcd1fb` | yes |
| GOOGLc | `0xb2000000000000000000002D0BA3164cc74f58B7` | yes |
| METAc | `0xb2000000000000000000008bC8786B856E61707C` | yes |
| NVDAc | `0xb20000000000000000000078ee7ce2fE4908108C` | yes |
| AMZNc | `0xb200000000000000000000d9192b6B456483C2E8` | not yet |
| MSFTc | `0xB200000000000000000000Ab99cFa739E253872B` | not yet |
| TSLAc | `0xb2000000000000000000001e800a7f5189430cD0` | not yet |
| COINc | `0xb200000000000000000000c85a31389D71F3ecfb` | not yet |
| CRCLc | `0xB20000000000000000000019f6E7C675b73C2e4D` | not yet |
| MSTRc | `0xb2000000000000000000004884b426556b92883d` | not yet |
| INTCc | `0xB2000000000000000000004AFF16039bA04bdFBc` | not yet |
| SNDKc | `0xb200000000000000000000397293Cb8cda9a10c5` | not yet |
| SPCXc | see `src/lib/b20/registry.ts` | not yet |

"Issued" means `totalSupply > 0`. "Deployed ≠ tradable": a contract with zero supply has no pool and no route; the UI labels it *Not issued yet* and sorts it behind live names. Trading opens automatically when supply appears.

- Transfer policy ids are `sender 5 · receiver 5`; policy 5 authorises any address (`isAuthorized(uint64,address)`), so nothing onchain blocks a holder today; `pausedFeatures` is empty. Pauses and policy changes are read before every action (`b20-guard-service`).
- `extraMetadata("isin")` is set per token; `newUIMultiplier` / `effectiveAt` expose scheduled multiplier changes (corporate actions).
- Coinbase deploys through `0x4ba3e29e254f25e94e61c4c9d67b37027331534d`; the creator EOA is `0xe090ecbee12d4b6aee5e73ff60945f2545ef5c6f`. Discovery (`b20-asset-service.discoverNewAssets`) scans `B20Created(address indexed token, uint8 indexed variant, string name, string symbol, uint8 decimals, bytes variantEventParams)` (topic0 `0xfd9bf273…`), keeps variant 0 with a symbol matching `/^[A-Z0-9.]{1,7}c$/`, requires the Coinbase creator, a Chainlink "Coinbase <TICKER>" feed and a unique ticker before auto-verifying; everything else lands in `/admin` as a candidate. The oracle registry answers 1e18 for any address and is therefore not used as a signal (22+ copycat NVDAc/METAc tokens exist).

### 3.2 Other contracts

| Purpose | Address |
| --- | --- |
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Native ETH sentinel (aggregators) | `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` |
| Aerodrome Slipstream factory (current) | `0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef` |
| Aerodrome Slipstream factory (legacy) | `0x5e7BB…` (see `src/providers/earn/aerodrome/adapter.ts`) |
| Aerodrome v2 factory | `0x420DD…` |
| Aerodrome Slipstream position manager (current / legacy) | `0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53` / `0x8279…5b72` |
| Uniswap v3 factory | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` |
| Uniswap v3 position manager | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` |
| NVDAc/USDC primary pool (Slipstream) | `0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9` |
| Basenames L2 resolver | see `src/config/chain.ts` |

### 3.3 Chainlink reference feeds

Feeds are looked up from the Chainlink Base directory (`https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json`, names "Coinbase <TICKER>"). They are **total-return** prices (multiplier already applied), heartbeat 24 h, 0.5 % deviation during US market hours. Freshness classes (`src/lib/market-hours.ts`): `live`, `last-close` (market closed), `stale` (older than `ORACLE_STALENESS_SECONDS`, default 93,600), `frozen` (paused for a corporate action). The reference is never used as an executable price.

---

## 4. Market data

| Source | Used for | Auth |
| --- | --- | --- |
| DexScreener | Market price, 24h change, volume, liquidity, primary pair (token is base by construction) | none |
| GeckoTerminal | OHLCV candles (`/pools/{pool}/ohlcv`), token metadata/logos, top pools per token (`?include=top_pools`), price fallback | none, ~30 req/min (rate gate 2.2 s) |
| Chainlink | Reference price and freshness | onchain |
| OKX DEX API | optional candles/trades fallback (only when the project is entitled) | signed |

Price model (`src/services/price-service.ts`): `displayUsd` is the DEX market price when a pool exists, otherwise the Chainlink reference (marked *reference*); `executablePriceUsd` comes from the provider quote; price impact is measured against the reference or market basis. Sparklines are 7-day closes. The status model (`src/lib/trading-status.ts`) turns liquidity into Live (≥ $100k), Thin ($10k–100k), No pool, Not issued, Paused.

---

## 5. Trading

### 5.1 Providers (`src/providers/trading`)

| Provider | Endpoint | Auth | Notes |
| --- | --- | --- | --- |
| KyberSwap aggregator | `aggregator-api.kyberswap.com/base/api/v1/routes` + `/route/build` | client id, optional key | Routes through Aerodrome CL for B20. Always on. |
| Velora (ParaSwap) | v6 API | none | Routes through Aerodrome/Uniswap. Always on. |
| Uniswap Trading API | `trade-api.gateway.uniswap.org` (`check_approval`, `quote`, `swap`), `routingPreference: BEST_PRICE`, `x-permit2-disabled` | `UNISWAP_API_KEY` | Covers v3 and v4 pools. |
| Aerodrome direct | onchain quoter on the Slipstream pool | none | Reference route; no native ETH sells. |
| 0x Swap API v2 (allowance-holder) | `api.0x.org/swap/allowance-holder/*` | `ZEROX_API_KEY` | Refuses B20 both directions (`*_TOKEN_NOT_AUTHORIZED_FOR_TRADE`) until a manual opt-in (email william@0xproject.com, "xStocks Opt-in"); refusal state is global and re-probed hourly. Requires `GEOBLOCK_MODE=block`. |
| OKX DEX aggregator (Onchain OS) | `web3.okx.com/api/v5/dex/aggregator/{quote,swap,approve-transaction}` | `OKX_API_KEY` + `OKX_SECRET_KEY` + `OKX_PASSPHRASE` (HMAC-SHA256 headers) | The project must be entitled to the aggregator service; a `50125` answer marks the provider *no access* for an hour and the Status page says so. Candles worked with the current key; quote/swap/market price answered 50125 on 2026-09-03. |

### 5.2 Flow

1. **Indicative price** (`POST /api/trade/price`): `b20Guard.preTradeCheck` (canonical asset, pause, policy, region), amount validation, then `compareProviders` asks every configured provider at once (2.5 s budget each), values each answer in USD at the current price minus the estimated network fee, and returns the best plus every alternative (`TradeQuoteAlternative`). The panel renders a route picker; auto = best net, manual = that provider only (`strictProvider`).
2. **Firm quote** (`POST /api/trade/quote`): the chosen provider first, hedged fallback behind it unless strict; returns calldata, spender, min received, expiry.
3. **Allowance**: exact amount, only to the spender the provider returned; native ETH sells skip it.
4. **Simulation** with `eth_call` before any signature; failures are explained (`humanizeError`).
5. **Submit**: EOA wallets sign sequentially; Base Account batches approval + swap atomically (EIP-5792) with sponsored gas when `NEXT_PUBLIC_PAYMASTER_URL` is set. Calldata carries the ERC-8021 Builder Code suffix (`bc_71vd6x2w` by default, `NEXT_PUBLIC_BASE_BUILDER_CODE` overrides it); batched sends also pass it as the EIP-5792 `dataSuffix` capability so smart wallets append it to the outer UserOperation callData. The site head carries `base:app_id` for web attribution.
6. **Tracking**: Submitted → Preconfirmed (Flashblocks RPC) → Confirmed; a trade record is written and later verified against onchain `Transfer` logs (activity marks unverified app records).
7. **Pay with ETH**: buys can sell native ETH (`payWith: "ETH"`); the USD amount is converted with the live ETH price; no bridge needed.
8. **Gifts**: buy-for-recipient delivers straight to the recipient; send-existing uses `transferWithMemo(bytes32)` with a reconciliation memo; both create a gift record, a public receipt page and a share sheet (Base app / X / copy). Recipients are resolved server-side: Basename forward or reverse (forward-verified), avatar, and the BStocks profile (member badge, handle when public).

---

## 6. Earn and liquidity

- **Discovery** (`src/services/earn-opportunity-service.ts`): per asset, in parallel with 7 s timeouts: Morpho (vaults via API with `allRewards` / `netApyExcludingRewards`; borrow markets by `collateralAssetAddress_in`), Aave V3 (reserve list onchain), Compound v3 (Comet markets), Aerodrome (v2 factory + two Slipstream factories), Uniswap v3 (factory `getPool` for the standard fee tiers against USDC and WETH), plus GeckoTerminal top pools for Uniswap v4 and other venues. `/api/earn` reports what was scanned and which venue did not answer, and the UI prints it in empty states.
- **In-app execution** (`/api/earn/prepare` → `EarnDepositSheet`): Morpho vaults (ERC-4626, "Powered by Morpho" + disclaimer acknowledgement), Aave V3, Compound v3; exact approval, simulation, atomic batch on Base Account; `earn_actions` records verified by receipt. Pools and borrow markets open on the venue while positions stay tracked here.
- **LP positions** (`src/services/lp-positions-service.ts`): Uniswap v3 and Slipstream position managers → amounts from liquidity and ticks (`src/lib/earn/lp-math.ts`), USD value, range in USD per share, in/out of range, uncollected fees via a simulated `collect`. Counted in the portfolio total, shown on the Earn page and as an "In liquidity pools" line on the stock page.
- **Liquidity map** (`/api/market/[address]/pools`): every pool GeckoTerminal lists for a stock, with flags: prices from here, routed, LP tracked, on Earn tab, plus totals. Reserves matched onchain balances within 0.3 % when verified.
- **Earn value** in the portfolio: USDC positions (vault shares → assets, aToken balances, Comet balances) + LP value.

---

## 7. Strategies: Build, Community, Automate

- **Build**: allocation editor (sliders / exact weights, USDC cash share), server-validated plan (`POST /api/portfolio/plan`) with per-leg indicative quotes, execution leg by leg with honest partial-fill state and per-leg retry (`portfolio-execution`). Allocations whose token is not issued are **deferred**: policy `reserve` keeps their money as USDC, `redistribute` spreads their weight across live names.
- **Guided AI draft** (`POST /api/portfolio/intent`): the request is composed from choices (theme, risk profile, cash share, exclusions, live-only) plus optional free text; the server adds market context per ticker (live or not, price, 24h move, DEX liquidity, sector tags), asks for strict JSON, re-validates symbols and weights, and returns what was sent so the UI can show it. Risk profiles bound position counts and maximum weights.
- **Templates**: seeded in `src/content/templates.ts`, stored in `portfolio_templates`; shown as cards with an allocation bar, live count and tags; "Load into editor" or open the template page.
- **Community**: published baskets (`baskets`, `basket_votes`), 7-day pulse from trade records, clones; profiles with handle, display name, bio, visibility; badges with server-computed progress (`computeBadges`); referrals (`referrals`: claim on first sign-in through a tagged link, first trade marks *traded*).
- **Automate**: rules (`automation_rules`) for recurring buys and basket plans; `isDue` proposes runs, the user executes them through the same execution engine; guided drafting builds a plan deterministically; free text goes through `POST /api/automation/intent` (live tickers only). Unattended execution (Spend Permissions) is on the roadmap.

---

## 8. AI

- **Provider abstraction** (`src/lib/ai-provider.ts`): Anthropic structured outputs or any OpenAI-compatible JSON-mode API (`AI_PROVIDER=openai`, `AI_BASE_URL`, `AI_MODEL`; DeepSeek in use). For OpenAI-compatible models the zod schema is embedded as JSON Schema in the system prompt (models otherwise invent key names); output is validated with zod and parse failures are logged as `ai.parse`.
- **Cost controls** (`src/lib/ai-quota.ts`): per-wallet, per-IP and global daily quotas, burst limit, monthly budget (`AI_MONTHLY_BUDGET_USD`) tracked in `ai_usage`; per-call output caps; identical requests are cached 10 minutes; failures are never cached.
- **Uses**: basket drafts, plan drafts, shared market brief (`ai_digests`, one per 6-hour UTC slot, at most four calls a day for everyone, fallback to the last stored brief), per-wallet daily portfolio brief (sign-in required, once per UTC day). Prompts forbid advice, predictions and invented facts; headlines are titles only and marked untrusted; the model never sees contract addresses or calldata.

---

## 9. Compliance

- Coinbase Tokenized Stocks are offered to eligible persons outside the United States. `GEOBLOCK_COUNTRIES` (default `US`) + `GEOBLOCK_MODE`: `attest` (default) shows an eligibility notice and lets the visitor self-certify (HttpOnly cookie `bstocks_eligibility`, 30 days), `block` answers 451 on execution routes. `/api/region` tells the UI the country, mode and current state. Nothing onchain blocks a holder today (policy 5), so the interface rule plus the legal notice is the enforcement layer; 0x's opt-in requires `block`.
- The legal notice (footer, Settings, How it works) states: independent interface, not a Coinbase or Base product, no investment advice, templates are not recommendations, yields are variable.

---

## 10. Storage (Supabase)

`trade_records`, `gifts`, `portfolio_executions` + `portfolio_execution_steps`, `portfolio_templates` + `portfolio_template_allocations`, `portfolio_snapshots` (daily value history), `watchlists`, `profiles`, `baskets` + `basket_votes`, `referrals`, `automation_rules`, `earn_actions`, `discovered_assets` (with `underlying`, `chainlink_feed`, `tags`, `eligible`, `auto_verified`, `creator`, `reason`), `ai_usage`, `ai_digests`. Schema: `supabase/schema.sql`; migrations were applied through the Supabase MCP.

---

## 11. Environment variables

| Variable | Purpose |
| --- | --- |
| `BASE_RPC_URL`, `NEXT_PUBLIC_BASE_RPC_URL`, `FLASHBLOCKS_RPC_URL` | Chain reads, client reads, preconfirmations |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Storage (memory fallback when absent) |
| `AUTH_SECRET` | SIWE session signing |
| `NEXT_PUBLIC_REOWN_PROJECT_ID` | AppKit wallet modal and onramp providers |
| `NEXT_PUBLIC_PAYMASTER_URL` | Sponsored gas for Base Account batches |
| `NEXT_PUBLIC_BASE_BUILDER_CODE` | ERC-8021 attribution suffix (set at deploy) |
| `NEXT_PUBLIC_APP_URL` | Absolute links in share sheets |
| `ZEROX_API_KEY`, `ZEROX_SWAP_FEE_BPS`, `ZEROX_SWAP_FEE_RECIPIENT` | 0x (refuses B20 until opt-in) |
| `KYBER_CLIENT_ID`, `KYBER_API_KEY` | KyberSwap |
| `UNISWAP_API_KEY` | Uniswap Trading API |
| `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`, `OKX_PROJECT_ID` | OKX DEX API |
| `AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`, `ANTHROPIC_API_KEY`, `AI_MAX_OUTPUT_TOKENS`, `AI_MONTHLY_BUDGET_USD` | Assistant |
| `ORACLE_STALENESS_SECONDS` | Reference freshness threshold (93,600) |
| `GEOBLOCK_COUNTRIES`, `GEOBLOCK_MODE` | Compliance |
| `ADMIN_API_TOKEN` | `/admin` verification |
| `CRON_SECRET` | Bearer token Vercel Cron sends to `/api/cron/refresh` (discovery + status on serverless) |
| `MORPHO_API_URL`, `MARKET_WARMUP` | Optional overrides |

No CoinGecko key is used (keyless DexScreener + GeckoTerminal). Coinbase Onramp is deliberately not integrated.

---

## 12. API routes

| Route | Purpose |
| --- | --- |
| `GET /api/assets`, `/api/assets/[address]` | Verified assets with prices, oracle state, supply, multiplier schedule |
| `GET /api/market/[address]`, `/ohlcv`, `/pools` | Market snapshot, candles, liquidity map |
| `GET /api/sparklines` | 7-day closes for all stocks |
| `POST /api/trade/price`, `POST /api/trade/quote` | Comparison price, firm quote |
| `POST /api/trades`, `GET /api/tx/[hash]` | Trade records, tx status |
| `GET/POST /api/portfolio/plan`, `/[address]`, `/executions`, `/intent`, `/digest` | Plans, snapshot, executions, AI basket draft, daily brief |
| `GET/POST/PATCH /api/automation`, `POST /api/automation/intent` | Rules, AI plan draft |
| `GET /api/earn`, `/api/earn/[address]`, `POST /api/earn/prepare`, `GET /api/earn/lp` | Discovery, deposit calls, LP positions |
| `GET/POST /api/gifts`, `GET/PATCH /api/gifts/[id]` | Gift records and receipts |
| `GET /api/basename/resolve`, `/reverse` | Recipient resolution with profile |
| `GET /api/activity/[address]` | Timeline with onchain verification |
| `GET /api/profiles/[ref]`, `/me`, `GET/POST /api/baskets`, `/api/community/pulse`, `/api/referrals`, `/api/watchlist` | Community and profile |
| `GET /api/news`, `/api/news/digest` | Headlines, shared brief |
| `GET/POST /api/region`, `/api/config`, `/api/status`, `/api/health` | Region and attestation, public flags, live checks, metrics |
| `/api/auth/*` | SIWE nonce, verify, session |
| `/api/admin/*` | Discovery verification |

---

## 13. Operations

- `/status` probes: Base RPC, Chainlink feed, DexScreener, GeckoTerminal, 0x, KyberSwap, OKX, Uniswap API, Velora, Aerodrome, Morpho, Aave, Compound, DEX pools, discovery, Basenames, Supabase, AI provider, news feeds, Builder Code. HTTP 429 is reported as degraded, not down.
- `/api/health` exposes the metrics registry (calls, errors, last error per counter, breaker opens) in non-production or with the admin token.
- Checks used in development: `pnpm exec tsc --noEmit`, `pnpm exec eslint src`, `pnpm exec vitest run`, `pnpm exec next build`.

## 14. RPC and provider economy

- Public data is fetched once per window and shared: assets, prices, oracle state, OHLCV, pools, earn discovery and the shared AI brief all live in the in-process cache; ten visitors cost one upstream call per window, not ten. The cache is bounded (5,000 keys, swept every two minutes).
- Per-wallet data (balances, LP positions, activity, the portfolio snapshot) is unavoidable per user but is also cached briefly per wallet (snapshot 15 s, activity 90 s, LP 30 s) and invalidated when the app itself records a trade.
- The activity timeline scans `Transfer` logs incrementally: after the first 120k-block scan, a refresh reads only the blocks mined since the last scan.
- Client polling is deliberately slow (balances 30 s, portfolio 45 s, activity 120 s, assets 30 s against the server cache) and pauses in background tabs through React Query defaults.
- Background work (market warm-up every 30 s, status probes every 5 min) runs only while a request arrived in the last 10 minutes (`src/lib/activity-pulse.ts`); an idle deployment makes no calls. Asset discovery (every 30 min) and the hourly 0x probe are the only unconditional jobs.
- Status checks are cached 60 s; a single failed probe shows as *degraded*, an *outage* needs two consecutive failures; the page shows the last 12 probe results per component.
