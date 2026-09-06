# BStocks — technical reference

BStocks is a self-custodial consumer interface for **Coinbase Tokenized Stocks on Base** (the B20 standard). It shows prices, routes trades through DEX aggregators, builds and automates baskets, discovers yield venues, sends stock to Basenames, and explains everything it does. It never holds keys or funds, never signs on page load, and treats every external text (headlines, RSS, model output) as data, not instructions.

This document is the technical reference. The product narrative and FAQ are on the in-app page `/how-it-works`; the backlog is in [ROADMAP.md](./ROADMAP.md).

---

## 1. Feature map

| Area | Route | What it does |
| --- | --- | --- |
| Home | `/` | Quick buy (live stocks first), movers, news brief, portfolio summary, platform counters, the public feed ("Live on Base": latest verified transactions, no wallet named), ticker rows (prices on by default, headlines opt-in). |
| Markets | `/markets` | All 13 stocks with status chip (Live / Thin / Very thin / No pool / Not issued / Paused), sparkline, price, 24h, Chainlink reference, single Buy action. A List / Heatmap toggle (remembered on the device) swaps the table for tiles coloured by the 24h move with the three deepest markets doubled; the search applies to both, and there are no other filters — thirteen stocks do not need a screener. All client-side over the assets response the page already holds. Region notice for restricted visitors. |
| Stock | `/stocks/[address]` | Price header with freshness — one price, the pool's; the reference is not shown on the stock page (only the feed address in Details) — a "this stock on BStocks" box in Details (from the platform statistics), candles + volume with zoom, trade panel (USDC or ETH, route picker, gift mode), tabs: Your position (+ LP line, your trades), Earn or borrow, Details (contract, oracle, liquidity map). |
| Strategies | `/build`, `/community`, `/automate` | One section with three routed tabs: Build (guided AI draft, allocation editor, plan preview, templates, publish, hand-off to Automate), Community (7-day pulse, published baskets, votes, clones), Automate (auto-invest plans run by the AutoInvest contract, or plans you confirm per run; guided or AI-drafted). Template pages live under `/build/[slug]`, community baskets under `/baskets/[id]` and public pages under `/u/[ref]`, all inside the section shell. |
| Earn | `/earn` | Idle-USDC venues executed in-app (Morpho vaults, Aave V3, Compound v3), your liquidity positions, stock-specific venues with type filters and an honest scan note. |
| Portfolio | `/portfolio` | Value (stocks + USDC + Earn + LP), allocation, history (with the equal-weight index of the listed stocks as a dashed benchmark), daily AI summary, gift inbox, plans card, Earn card; tabs in the URL (`?tab=rebalance`): Rebalance (drift against a template or a saved target, one measure everywhere, blocked legs shown as such, threshold 2.5/5/10%, and "return to target on a schedule" — a buy-only manual plan), Activity, Profile (Basename identity, visibility, badges with progress). |
| Public profile | `/u/[handle-or-address]` | Allocation in percent (if public), badges, published baskets, referral counters. |
| Gift receipt | `/gifts/[id]` | Public page for a submitted gift: from, to, amount, message, tx proof, share. |
| Gift pools | `/pools`, `/pools/[id]` | One deposit, many equal shares: public directory, claim page and the creator's roster + close-and-withdraw panel. A basket can be gifted as a package: "Gift as a package" on a template or in Build opens the pool creator with the basket's stocks pre-picked and one share (`/gifts?basket=0x…,0x…&title=`; stocks the wallet does not hold are left out and named). Gift links, bulk links and pool links can be printed as QR cards (`src/lib/print-cards.ts`: drawn in the browser, four A6 cards to an A4 sheet, no server sees the link). |
| News | `/news` | Headlines per stock and market-wide, "Today's brief" (shared AI summary every 6 h). |
| Copilot | every page | Floating assistant panel (`src/components/assistant`): answers from live tool data and drafts actions the user signs. Launcher on every page, plus a card under the hero on `/`. Hidden when no AI key is configured. |
| Settings | `/settings` | Slippage, ticker rows, motion, diagnostics (providers, geoblock mode, storage backend). |
| Status | `/status` | Live probes of every dependency. |
| Stats | `/stats` | Platform statistics with the verified ledger; every figure is one receipt on Base. Rows from the reader's own timeline are marked "you" (client-side, nothing is sent). Daily rollups keep the cost flat as records grow (§10). |
| Reference | `/docs/reference` | `docs/HOW_IT_WORKS.md` rendered at build time (`src/lib/markdown.ts`), so the page and the file cannot drift; `/docs` stays the hand-written narrative. |
| Install | `/manifest.webmanifest` | Web app manifest (`src/app/manifest.ts`): installable on phones and desktops, standalone window, shortcuts to Markets, Portfolio and Gift. No service worker on purpose — a page that quotes prices must never be served stale from a cache. |
| How it works | `/how-it-works` | Narrative, safety model, fees, FAQ. |
| Admin | `/admin` | Verification of newly discovered B20 tokens (admin token). |

---

## 2. Architecture

- **Next.js 16 (App Router, Turbopack), React 19, TypeScript strict, Tailwind 4, pnpm, Vitest.** Server code lives in `src/services` (orchestration), `src/providers` (one adapter per external system), `src/domain` (types and pure rules), `src/db` (repositories with a memory backend and a Supabase backend), `src/lib` (cache, HTTP, rate gate, fallback racing, AI provider, quotas, math). UI lives in `src/components`, pages in `src/app`, route handlers in `src/app/api`.
- **Caching.** `src/lib/cache.ts` is an in-process TTL + stale-while-revalidate cache keyed per resource; one upstream request serves every visitor for a window. Keys marked `shared` (the asset registry, oracle reads, prices, feeds, Earn discovery, news, status, the statistics, the index tail) also go through a **shared tier** (`src/lib/shared-store.ts`): Upstash Redis when `UPSTASH_REDIS_REST_URL`/`_TOKEN` are set, otherwise the `kv_cache` table in Supabase — so on serverless, one instance computes and every other instance reads. Values are encoded with `src/lib/codec.ts` (bigints, Maps and Sets survive). `src/lib/rate-gate.ts` serialises calls to keyless APIs (GeckoTerminal ≈ 30 req/min). `src/lib/http.ts` provides `fetchJson`, per-provider circuit breakers and a metrics registry surfaced on `/api/health` and `/status`.
- **Rendering.** The root layout reads no cookie, so pages are not dynamic per request: pages with server data (home, markets, a stock, build, templates, baskets, profiles, automate, portfolio) carry `revalidate` (30–60 s) and are served from the cache between renders; wagmi hydrates the wallet connection on the client (a connected wallet shows "Connect" for a moment on a full page load). Gift receipts and pool pages stay `force-dynamic`. The wallet modal (`@reown/appkit/react`), the dithered backdrop and the 3D coins are loaded in the browser on demand (`src/config/appkit.ts`, `src/components/fx/lazy.tsx`), so a visitor who only reads prices never downloads them.
- **Errors.** `src/lib/error-sink.ts` records every error — route handlers through `route()`, server rendering through `onRequestError` in `src/instrumentation.ts`, the browser through `src/app/error.tsx` / `global-error.tsx` and `POST /api/errors` — as one counted row per distinct error in `error_events`. `/admin` lists them; `/api/health` counts the last hour and raises an alert past a threshold.
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

Price model (`src/services/price-service.ts`): `displayUsd` is the DEX market price when a pool exists, otherwise the Chainlink reference (marked *reference*); `executablePriceUsd` comes from the provider quote; price impact is measured against the reference or market basis. Sparklines are 7-day closes. The status model (`src/lib/trading-status.ts`) turns liquidity into Live (≥ $100k), Thin ($10k–100k), Very thin (a pool under $10k — labelled with a slippage warning rather than "No pool yet", which would contradict the size printed beside it), No pool (nothing at all), Not issued (zero supply), Paused. Only Live and Thin count towards "live markets" in the hero and market totals, so a $108 pool never inflates them.

---

### 4.1 A bad minute upstream is never shown as a fact

Two readings used to turn a transient failure into a claim about the stock: a `totalSupply` call the node did not answer was stored as `0` (so every stock read "Not issued yet" for as long as the cache held it), and a round where DexScreener and GeckoTerminal both answered nothing was cached as an empty market for its window (so every stock read "No pool" and the counters "0 live"). Both now go through `src/lib/last-good.ts`: the last value a loader ever produced, kept in memory and in the shared store for 30 days, replaced by the next good read and read back on the next bad one. The live-state batch (`b20:live`) takes the previous value per call that failed and the previous batch when the node refuses the whole multicall; the feeds (`b20:feeds`) likewise; the market snapshot (`market:snapshot`) fills each token the providers missed from its last reading for up to 24 h, keeping that reading's own `updatedAt`. An empty provider round is refused (`keyless: no market data from any provider`) rather than cached. A supply that was never read is `supplyKnown: false` on the asset, and `isNotIssued` / `isIssued` in `trading-status.ts` — the only places that decide issuance — treat it as unknown, never as zero. The counters on Home and Markets show "—" while nothing is known rather than "0".

## 5. Trading

### 5.1 Providers (`src/providers/trading`)

| Provider | Endpoint | Auth | Notes |
| --- | --- | --- | --- |
| KyberSwap aggregator | `aggregator-api.kyberswap.com/base/api/v1/routes` + `/route/build` | client id, optional key | Routes through Aerodrome CL for B20. Always on. |
| Velora (ParaSwap) | v6 API | none | Routes through Aerodrome/Uniswap. Always on. |
| Uniswap Trading API | `trade-api.gateway.uniswap.org` (`check_approval`, `quote`, `swap`), `routingPreference: BEST_PRICE`, `x-permit2-disabled` | `UNISWAP_API_KEY` | Covers v3 and v4 pools. |
| Aerodrome direct | onchain quoter on the Slipstream pool | none | Reference route; no native ETH sells. |
| 0x Swap API v2 (allowance-holder) | `api.0x.org/swap/allowance-holder/*` | `ZEROX_API_KEY` | Refuses B20 both directions (`*_TOKEN_NOT_AUTHORIZED_FOR_TRADE`) until a manual opt-in (email william@0xproject.com, "xStocks Opt-in"); refusal state is global and re-probed hourly. Requires `GEOBLOCK_MODE=block`. |
| OKX DEX aggregator (Onchain OS) | `web3.okx.com/api/v6/dex/aggregator/{quote,swap,approve-transaction}` | `OKX_API_KEY` + `OKX_SECRET_KEY` + `OKX_PASSPHRASE` (HMAC-SHA256 headers) | The project must be entitled to the aggregator service; a `50125` answer marks the provider *no access* for an hour and the Status page says so. v5 was deprecated (50050) on 2026-09-03; the adapter uses v6 (`slippagePercent`, no `chainId`). Quote, swap and approve-transaction verified with the current key on 2026-09-03. |
| CoW Protocol | `api.cow.fi/base/api/v1/{quote,orders,account/{owner}/orders,app_data}` | none | Signed-order flow, not a swap transaction: exact approval of GPv2VaultRelayer `0xC92E…0110`, EIP-712 `Order` (EIP-1271 for smart accounts) on GPv2Settlement `0x9008…ab41`, order posted with the full appData document (schema 1.3.0) + hash. Solvers pay gas; the fee is inside the price, so the comparison values it at zero network fee. Market orders are valid 30 min; the order book caps validity at 3 h, which bounds limit orders too. EOAs cancel with a signed `OrderCancellations`; smart accounts call `invalidateOrder`. Native ETH is refused as sell token. Left out of basket legs (`orders: false`). |
| GiftEscrow (ours) | `0x8D9fE4b3Ab9BecbE1181d15d51FB9724561C7f55` on Base | none | Claim-link gifts (`contracts/src/GiftEscrow.sol`, 17 Foundry tests). Ownerless: only pays the claim-signed recipient or refunds the sender. The link fragment carries an ephemeral key; its address hashes to the onchain gift id, EIP-712 `Claim(giftId,recipient)` binds the recipient, anyone may submit (sponsored claims). Expiry ≤ 90 days; sender can cancel any time. Routes: `/gifts/claim/[id]` + share card. |
| AutoInvest (ours) | `0xc767844F2D65ba241DBe2c04f9c01d05cCD9b60E` on Base (deployed 2026-09-05, source verified on Basescan; owner `0x78de…87FF`, keeper `0xffA7…c39C`; initial allow-list KyberSwap, Aerodrome, OKX routers) — see [AUTO_INVEST.md](AUTO_INVEST.md) | keeper key on the server | Recurring purchases that run without the owner (`contracts/src/AutoInvest.sol`, 31 Foundry tests). A plan = legs + weights + amount per run + cadence + expiry + slippage tolerance; `execute` pulls one run's USDC under a normal allowance, swaps through an allow-listed router with the owner as recipient, checks the owner's balance grew by at least `max(minOut, Chainlink floor)`, refunds leftovers. Amount, cadence, routes (24 h announcement for additions) and output are enforced onchain; the keeper only chooses timing and route. |

### 5.2 Flow

1. **Indicative price** (`POST /api/trade/price`): `b20Guard.preTradeCheck` (canonical asset, pause, policy, region), amount validation, then `compareProviders` asks every configured provider at once (2.5 s budget each), values each answer in USD at the current price minus the estimated network fee, and returns the best plus every alternative (`TradeQuoteAlternative`). The panel renders a route picker; auto = best net, manual = that provider only (`strictProvider`).
2. **Firm quote** (`POST /api/trade/quote`): the chosen provider first, hedged fallback behind it unless strict; returns calldata, spender, min received, expiry.
3. **Allowance**: exact amount, only to the spender the provider returned; native ETH sells skip it.
4. **Simulation** with `eth_call` before any signature; failures are explained (`humanizeError`).
5. **Submit**: EOA wallets sign sequentially; Base Account batches approval + swap atomically (EIP-5792) with sponsored gas when `NEXT_PUBLIC_PAYMASTER_URL` is set. Calldata carries the ERC-8021 Builder Code suffix (`bc_71vd6x2w` by default, `NEXT_PUBLIC_BASE_BUILDER_CODE` overrides it); batched sends also pass it as the EIP-5792 `dataSuffix` capability so smart wallets append it to the outer UserOperation callData. The site head carries `base:app_id` for web attribution.
6. **Tracking**: Submitted → Preconfirmed (Flashblocks RPC) → Confirmed; a trade record is written and **matched to the chain before it counts** (`src/services/tx-verify-service.ts`, pure checks in `src/lib/chain/receipt-checks.ts`): the receipt must show the stock arriving in (or leaving) the wallet the record names — who sent the transaction is never the test, a bundler or relayer may have — and the settled USDC from the receipt replaces the browser's USD figure. A record whose receipt is not in yet is kept pending and settled by the verification sweep (`src/services/verify-records-service.ts`, cron job `verify`); one the receipt contradicts is refused (`TX_MISMATCH`) or, if it was filed while pending, marked failed with the reason and never shown or counted. The same rule covers gifts (`Transfer` sender → recipient, or the escrow's `GiftCreated` / `GiftClaimed` / `GiftReclaimed` for that escrow id — the claimant is read from the log), Earn (the venue's `Supply`/`Deposit`/`Withdraw` naming the wallet), pools (`PoolCreated` / `PoolClaimed`) and the watchlist (owner session). `verified_at` on the row is the mark; `tx_receipts` keeps the receipt so the chain is asked once per hash. The activity timeline (`src/lib/activity/timeline.ts`, pure and tested) holds to *one transaction, one row*: a basket's leg trades fold into the basket, an AutoInvest run's per-stock rows fold into one run, a gift bought for someone is the gift (with the purchase price on it), gift links funded together are one row with a count, and pool deposits and claims appear as their own rows. Transfers no record explains are still read from the chain.
7. **Pay with ETH**: buys can sell native ETH (`payWith: "ETH"`); the USD amount is converted with the live ETH price; no bridge needed.
8. **Gifts**: buy-for-recipient delivers straight to the recipient; send-existing uses `transferWithMemo(bytes32)` with a reconciliation memo; both create a gift record, a public receipt page and a share sheet (Base app / X / copy). Recipients are resolved server-side: Basename forward or reverse (forward-verified), avatar, and the BStocks profile (member badge, handle when public).

### 5.3 Gift pools (`contracts/src/GiftPool.sol`)

One deposit, many equal claims — the contract behind `/pools`. Ownerless like GiftEscrow: no admin, no pause, no upgrade, no fee, no token allowlist; it can only pay a claimant their exact share or return the unclaimed remainder to the creator. 64 Foundry tests, including four stateful invariants (conservation, solvency, claim-count agreement, no oversold slots).

- **No division onchain.** The creator states the amount per claim and the contract multiplies by the slot count, so nothing rounds and no dust is stranded. `splitIntoShares` does the flooring in the browser and shows the creator what stays in their wallet. The invariant that follows: `balanceOf(pool) >= amountPerClaim × (slots − claimed)` for every leg not yet withdrawn.
- **One gate, three products.** `gate == address(0)` is an open pool (one share per address, self-claim only, so nobody can spend a pool on addresses of their own choosing). Otherwise every claim carries an EIP-712 `Ticket(poolId, recipient, deadline)` signed by `gate` — an ephemeral link key held only in the share link's fragment, or the server's campaign signer (`POOL_GATE_SIGNER_KEY`) which signs after verifying quests. Gated claims may be submitted by anyone, so a relayer or a sponsored smart account can pay the gas. Low-`s` and `v ∈ {27,28}` are enforced.
- **Packages.** Up to 8 legs (`MAX_LEGS`), each paying a fixed raw amount per claim, all in one claim transaction. B20 `balanceOf` is the raw balance and does not rebase, so a share promised at creation is the same share at claim time.
- **Closing is two steps on purpose.** `cancel` only flips a flag and moves nothing, so a stock its issuer has paused can never keep the creator from closing the pool; `withdrawLeg` then brings tokens home one at a time and `withdraw` batches the healthy ones. Base Account does both in one atomic confirmation.
- **`lockedUntil`** lets a creator give up the right to cancel for a period — an onchain-verifiable promise, shown as a Locked badge.
- **Quests** never reach the contract, so a new requirement is server work rather than a new deployment (`src/services/quest-service.ts`). They come in two grades and the app labels them everywhere — picker, claim page and creator roster:
  - **Checked on Base** — `hold-basename` (reverse + forward resolution), `hold-asset` (`balanceOf`), `buy-asset` (candidate transactions come from `trade_records`, but each one is re-read from its receipt and only an ERC-20 `Transfer` of that asset into the claimant counts, because `/api/trades` is unauthenticated), `sign-in` (SIWE).
  - **Declared by the claimant** — `follow-bstocks`, `follow-x`, `repost-x`, `like-x`, `visit-url` (any http(s) page: a site, a Discord invite, a Telegram group, a video). Nobody can read a follow, a repost, a like or a page view from outside, so `POST /api/pools/[id]/attest` records the claimant's own confirmation against their signed-in wallet with a timestamp, in `questProof.attested` keyed by quest index. The claim page opens the destination, waits out a five-second confirmation window and then attests; the row reads "Confirmed by you", never "verified", and the creator's roster tags it `declared`. Nothing about this is a check and the copy never says it is.
  - A pool may hold up to `MAX_POOL_QUESTS` (8) steps and may **repeat a type** — three accounts to follow, two links to read — except `sign-in`, `hold-basename` and `follow-bstocks`, where a second copy would mean nothing (`SINGLETON_QUESTS`). Creator-supplied links are scheme-checked with `isHttpUrl` on both sides, because `new URL()` (and Zod's `.url()`) accepts `javascript:` and these go to `window.open`.
- **Who claimed.** `PoolClaimed` logs are the truth; the claim page reports its own transaction for speed (`confirmed`) and the daily cron sweep matches rows against logs (`reconciled`). Only the creator sees the roster.

---

## 6. Earn and liquidity

- **Discovery** (`src/services/earn-opportunity-service.ts`): per asset, in parallel with 7 s timeouts: Morpho (vaults via API with `allRewards` / `netApyExcludingRewards`; borrow markets by `collateralAssetAddress_in`), Aave V3 (reserve list onchain), Compound v3 (Comet markets), Aerodrome (v2 factory + two Slipstream factories), Uniswap v3 (factory `getPool` for the standard fee tiers against USDC and WETH), plus GeckoTerminal top pools for Uniswap v4 and other venues. `/api/earn` reports what was scanned and which venue did not answer, and the UI prints it in empty states.
- **In-app execution** (`/api/earn/prepare` → `EarnDepositSheet`): Morpho vaults (ERC-4626, "Powered by Morpho" + disclaimer acknowledgement), Aave V3, Compound v3; exact approval, simulation, atomic batch on Base Account; `earn_actions` records verified by receipt. Pools and borrow markets open on the venue while positions stay tracked here.
- **Reconciliation from the chain** (`src/services/earn-reconcile-service.ts`): the browser's record is a hint; Aave `Supply`/`Withdraw`, ERC-4626 `Deposit`/`Withdraw` and Comet `Supply`/`Withdraw` events are the truth. A cursor-driven sweep (`sync_cursors`, floor block 50,700,000) over every wallet the app knows fills in missing `earn_actions` rows and stores their receipts; it runs from the daily cron, before each statistics computation, and on demand via `POST /api/admin/earn/reconcile`. The activity timeline runs a per-wallet look over the last 30k blocks (incremental afterwards). Liquidity positions minted, withdrawn or harvested in the app write their own records (`action` `deposit` / `withdraw` / `collect`, provider `uniswap` / `aerodrome`, the USDC leg as the amount, both legs in USD at the pool price at the time).
- **LP positions** (`src/services/lp-positions-service.ts`): Uniswap v3 and Slipstream position managers → amounts from liquidity and ticks (`src/lib/earn/lp-math.ts`), USD value, range in USD per share, in/out of range, uncollected fees via a simulated `collect`. Counted in the portfolio total, shown on the Earn page and as an "In liquidity pools" line on the stock page.
- **Liquidity map** (`/api/market/[address]/pools`): every pool GeckoTerminal lists for a stock, with flags: prices from here, routed, LP tracked, on Earn tab, plus totals. Reserves matched onchain balances within 0.3 % when verified.
- **Earn value** in the portfolio: USDC positions (vault shares → assets, aToken balances, Comet balances) + LP value.

---

## 7. Strategies: Build, Community, Automate

- **Build**: allocation editor (sliders / exact weights, USDC cash share; locked while a plan built from it is executing), server-validated plan (`POST /api/portfolio/plan`) with per-leg indicative quotes, execution leg by leg with honest partial-fill state and per-leg retry (`portfolio-execution`). Legs the shared eligibility rule (`legBlockedReason`: not issued, no pool, paused, more than 2% of the pool) refuses today are **deferred** with the reason: policy `reserve` keeps their money as USDC, `redistribute` spreads their weight across live names. Legs that cannot be quoted are left out rather than queued to fail. "Repeat this basket on a schedule" hands the basket to Automate in the URL.
- **Guided AI draft** (`POST /api/portfolio/intent`): the request is composed from choices (theme, risk profile, cash share, exclusions, live-only) plus optional free text; the server adds market context per ticker (live or not, price, 24h move, DEX liquidity, sector tags), asks for strict JSON, re-validates symbols and weights, and returns what was sent so the UI can show it. Risk profiles bound position counts and maximum weights.
- **Templates**: seeded in `src/content/templates.ts`, stored in `portfolio_templates`; shown as cards with an allocation bar, live count and tags; "Load into editor" or open the template page.
- **Community**: published baskets (`baskets`, `basket_votes`), 7-day pulse from trade records, clones; profiles with handle, display name, bio, visibility; badges with server-computed progress (`computeBadges`); referrals (`referrals`: claim on first sign-in through a tagged link, first trade marks *traded*).
- **Automate**: two kinds of plan, both stored in `automation_rules` (`config_json.mode`). **Auto** plans live in the AutoInvest contract; the row is a mirror refreshed from the chain on every read (`listRulesSynced`), including plans created outside the app. The keeper tick (`GET|POST /api/cron/automation`, `src/services/auto-invest-keeper.ts`) runs due plans; the owner can also run a due plan from their wallet (`POST /api/automation/prepare-run` → `execute`). **Manual** plans propose a due run that the owner confirms leg by leg through the same execution engine; a run moves the schedule only when something was actually bought (`PATCH … action: "ran"` with a summary). The **target mix** (`drift-alert`) is not a plan: it is filtered out of every plan list, cannot be run, and carries the drift threshold. Guided drafting builds a plan deterministically; free text goes through `POST /api/automation/intent` (live tickers only). Details: [AUTO_INVEST.md](AUTO_INVEST.md).
- **Rebalance** (`/portfolio?tab=rebalance`, `src/lib/portfolio/drift.ts`): one drift measure for the Overview banner, the table and the proposed trades. The base is the stocks, plus cash only when the target holds a cash share; Earn and LP are never part of it. A leg trades only when it is at least 1% of the base and $5 out of line; blocked legs (same eligibility rule as Build) are shown with the reason and left out of the totals; cash is "spent" or "kept", never "sold".
- **Return to target on a schedule** (`src/lib/portfolio/toward-target.ts`, `config_json.towardTarget`): a manual basket plan created from the Rebalance tab against the saved target. On each run the legs are computed from the live holdings — only the stocks under target, split by how far under they are, capped at the plan's amount — and confirmed leg by leg in the wallet. It never sells and cannot be automatic (the API refuses `mode: "auto"` with `towardTarget`). A run that finds the mix within threshold is recorded as *in balance* (`summary.inBalance`) and moves to the next date rather than staying due. This is the safe form of "automatic rebalancing": bounded by the money it is given, and never a forced exit.
- **Benchmark** (`getBenchmarkIndex`, `src/services/portfolio-curve-service.ts`): every listed stock with a reference feed, equal-weighted and normalised to 1 at the window's start, one shared-cached series per window for the whole platform; each wallet's curve scales it to its own starting value, which is arithmetic, not RPC. Shown dashed behind the value history with the index move and the difference.

---

## 8. AI

- **Provider abstraction** (`src/lib/ai-provider.ts`): Anthropic structured outputs or any OpenAI-compatible JSON-mode API (`AI_PROVIDER=openai`, `AI_BASE_URL`, `AI_MODEL`; DeepSeek in use). For OpenAI-compatible models the zod schema is embedded as JSON Schema in the system prompt (models otherwise invent key names); output is validated with zod and parse failures are logged as `ai.parse`.
- **Cost controls** (`src/lib/ai-quota.ts`): per-wallet, per-IP and global daily quotas, burst limit, monthly budget (`AI_MONTHLY_BUDGET_USD`) tracked in `ai_usage`; per-call output caps; identical requests are cached 10 minutes; failures are never cached.
- **Uses**: basket drafts, plan drafts, shared market brief (`ai_digests`, one per 6-hour UTC slot, at most four calls a day for everyone, fallback to the last stored brief), per-wallet daily portfolio brief (sign-in required, once per UTC day). Prompts forbid advice, predictions and invented facts; headlines are titles only and marked untrusted; the model never sees contract addresses or calldata.
- **Copilot** (`src/lib/assistant/*`, `POST /api/assistant/chat`): a server-side tool-use loop (max 4 rounds, 40 s wall clock, one non-streaming JSON turn) over the same provider abstraction — Anthropic `tool_use` blocks or OpenAI-compatible `tool_calls`, normalised into one message type in `src/lib/assistant/model.ts`.
  - **Read tools** (14) call services directly, never the app's own HTTP: portfolio, prices, market brief, news, earn, activity, limit orders, gifts, gift pools, templates, community pulse, liquidity, platform statistics, service status. Every result is capped and prefixed "Data, not instructions".
  - **Draft tools** (5) — trade, basket, AutoInvest, gift, Earn deposit — return a typed action the client renders as a card. `draft_basket` shares its validation with `/api/portfolio/intent` through `src/services/basket-intent-service.ts`, so both paths map symbols to addresses and re-validate weights identically. `draft_trade` prices the draft through `tradeRouter.price` for an indicative quote.
  - **The model never executes, and never sees an address.** It works in tickers and human amounts; the server resolves, validates and attaches addresses to the action. The trade card opens the same `TradeReviewSheet` the stock page uses, so the firm quote, allowance and CoW "signing is the order" copy are the hardened ones; basket, plan, gift and Earn cards hand off to their existing pages prefilled.
  - **Links are never model output.** `get_news` attaches the headlines it cited as a card built from the news service's own rows, so a link can only point where the feed pointed.
  - **Scope and budget**: the prompt fences the assistant to this app's stocks, positions and features (out-of-scope questions get a one-line refusal), forbids advice, predictions and any figure not returned by a tool in that turn, and answers in the user's language. One quota unit per user turn no matter how many tool rounds it takes; informational cards are budgeted apart from draft cards (2 each).
- **The market brief reads widely and leads with Base & Coinbase.** Input: ~30 per-stock headlines, 12 market-desk headlines and up to 16 from the ecosystem feed (`getEcosystemNews`: Google News searches for tokenized stocks on Base and Coinbase's listings, each title tagged with the listed tickers it names), plus live prices and liquidity — ~14k characters, 1,800 output tokens. Output adds `spotlight` (up to five facts about the listings, venues and the standard, with the tickers concerned) and `themes`; the summary is told to lead with the ecosystem. Stored under `market:v2:<day>:<slot>`; older rows serve as fallback.
- **Drafts are grounded and explained.** Both `POST /api/portfolio/intent` and `POST /api/automation/intent` add the latest stored brief (`marketContextText`, never a fresh model call), the same Live / Thin / No pool status Markets shows, DEX liquidity, and a few recent headlines per live stock as context marked "data, not instructions". The basket draft returns `commentary` — thesis, why each leg and its weight, what could go against it, facts from the headlines — rendered under the editor as "Why this mix" (marked "for the draft as generated" once the user edits). The plan draft returns `commentary.why` and `commentary.watch`, shown under the assistant's draft. Commentary explains a template; the prompts forbid recommending or predicting.

---

## 9. Compliance

- Coinbase Tokenized Stocks are offered to eligible persons outside the United States. `GEOBLOCK_COUNTRIES` (default `US`) + `GEOBLOCK_MODE`: `attest` (default) shows an eligibility notice and lets the visitor self-certify (HttpOnly cookie `bstocks_eligibility`, 30 days), `block` answers 451. `/api/region` tells the UI the country, mode and current state. Nothing onchain blocks a holder today (policy 5), so the interface rule plus the legal notice is the enforcement layer; 0x's opt-in requires `block`.
- **What the edge closes** (`src/proxy.ts`, covered by `src/proxy.test.ts`): execution routes for every method (`/api/trade/*`, `/api/earn/prepare`, `/api/portfolio/{plan,quote,execute}`), and **writes only** on `/api/gifts` and `/api/pools` — creating a gift or a pool, and asking BStocks to sign a claim ticket, is distribution of a tokenized security. Reading a receipt, the pool directory or a quest checklist is browsing and stays open everywhere.
- **What the edge cannot close**: the claim transaction goes straight to the contract from the claimant's wallet. The eligibility notice on `/gifts/claim/[id]` and `/pools/[id]` is the gate there, as it is for any self-custodial transfer. The give side is gated in the UI too — `/gifts` shows the notice instead of the create flows for a restricted visitor.
- The legal notice (footer, Settings, How it works) states: independent interface, not a Coinbase or Base product, no investment advice, templates are not recommendations, yields are variable.

---

## 10. Storage (Supabase)

`trade_records`, `gifts`, `portfolio_executions` + `portfolio_execution_steps`, `portfolio_templates` + `portfolio_template_allocations`, `portfolio_snapshots` (daily value history), `watchlists`, `profiles`, `baskets` + `basket_votes`, `referrals`, `automation_rules`, `earn_actions`, `discovered_assets` (with `underlying`, `chainlink_feed`, `tags`, `eligible`, `auto_verified`, `creator`, `reason`), `ai_usage`, `ai_digests`, `tx_receipts` (verified receipts: hash, status, block, block time — written once, shared by every instance), `sync_cursors` (where each chain sweep left off), `kv_cache` (the shared cache tier), `wallet_index` + `chain_transfers` (the app's own index of tokenized-stock transfers for the wallets it knows), `error_events` (one counted row per distinct error). `trade_records`, `gifts`, `earn_actions` and `gift_pools` carry `verified_at` / `verify_note`. Schema: `supabase/schema.sql`; migrations were applied through the Supabase MCP.

---

### 10.1 Statistics at scale: daily rollups

`stats_daily` holds one row per finished day: the day's verified events reduced to counters, distinct wallets, per-stock, per-route and per-venue totals (`DayRollup`, built by `buildDayRollup` in `src/lib/stats/aggregate.ts`). A day is finished once it is 35 days behind (`LIVE_DAYS`); the `rollup` cron job reduces up to 14 such days per run, oldest first and contiguously, so "the day after the latest rollup" is always the live boundary. The live computation (`getPlatformStats`) then reads only records created after that boundary (gifts 120 days further back, because a claim link's record predates its claim by up to 90 days) and adds the rollups for everything before, event by event the same way; the 30-day windows, the daily chart and the ledger always come from live records. A rollup that overlaps the live window is ignored rather than double-counted. Without any rollups (a fresh database) everything is read live, as before. Status counters that are not events — open links, live pools, plans, executions, profiles — still come from their tables.

## 11. Environment variables

- `INTEGRATOR_FEE_BPS` / `INTEGRATOR_FEE_RECIPIENT`: integrator fee on routes that can carry one and price it into the quote (KyberSwap, CoW, 0x), in basis points, capped at 100; off unless both are set. Shown on the quote, stored on the trade record (`fee_bps`), summed on `/stats`.

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
| `NEXT_PUBLIC_GIFT_POOL_ADDRESS` | Deployed GiftPool. Empty hides gift pools entirely rather than pointing users at nothing |
| `POOL_GATE_SIGNER_KEY` | Campaign signer for quest-gated pools (server-only, 32-byte hex). Without it, open and link pools still work |
| `NEXT_PUBLIC_AUTO_INVEST_ADDRESS` | Deployed AutoInvest. Empty hides the Automatic option; plans are then confirmed by hand |
| `AUTOMATION_KEEPER_KEY`, `AUTOMATION_MAX_RUNS_PER_TICK` | Keeper signer for due auto plans (server-only); runs per tick (default 6). Without the key, owners run due plans from the app |
| `MORPHO_API_URL`, `MARKET_WARMUP` | Optional overrides |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Shared cache tier on Redis (optional; the `kv_cache` table is used without them) |

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
| `GET/POST /api/portfolio/plan`, `/[address]`, `/executions`, `/intent`, `/digest` | Plans, snapshot, executions (written and read only by the signed-in owner), AI basket draft, daily brief |
| `GET/POST/PATCH /api/automation`, `POST /api/automation/prepare-run`, `POST /api/automation/intent` | Rules (auto plans mirrored from the chain), owner-side run preparation, AI plan draft |
| `GET/POST /api/cron/automation` | Keeper tick (bearer `CRON_SECRET`): runs due auto plans, reports what it did |
| `GET /api/cron/refresh?job=` | Maintenance, one job per request (bearer `CRON_SECRET`): `index` (stock transfers touching indexed wallets), `verify` (records filed while pending), `earn` (venue events), `pools` (`PoolClaimed` logs), `rollup` (finished days reduced to `stats_daily`), `stats`, `status`, `discovery`, `sweep` (expired cache and rate-limit rows); `all` runs the sequence |
| `POST /api/assistant/chat` | Copilot turn: tool-use loop over live data, returns the reply plus typed action cards (nothing is executed) |
| `POST /api/errors` | The browser's error boundaries report here (rate-limited; a message and a path, never who) |
| `GET /api/earn`, `/api/earn/[address]`, `POST /api/earn/prepare`, `GET /api/earn/lp` | Discovery, deposit calls, LP positions |
| `GET/POST /api/gifts`, `GET/PATCH /api/gifts/[id]` | Gift records and receipts |
| `GET/POST /api/pools`, `GET/PATCH /api/pools/[id]` | Gift pools: public directory, a creator's own pools, create and presentation edits |
| `GET/POST /api/pools/[id]/ticket` | Quest checklist for the signed-in wallet, and the campaign signer's claim ticket |
| `POST /api/pools/[id]/attest` | The claimant's own confirmation of one X step (declared, never verified) |
| `GET/POST/PUT /api/pools/[id]/claims` | Claim roster (creator only), a claim page reporting its transaction, and the log reconciliation |
| `GET /api/basename/resolve`, `/reverse` | Recipient resolution with profile |
| `GET /api/activity/[address]` | Timeline with onchain verification |
| `GET /api/stats` | Platform statistics for `/stats` and the home module: every record verified by receipt, aggregated by `src/lib/stats/aggregate.ts` (pure, tested), recomputed every 5 min |
| `GET /api/profiles/[ref]`, `/me`, `GET/POST /api/baskets`, `/api/community/pulse`, `/api/referrals`, `/api/watchlist` | Community and profile |
| `GET /api/news` (`?scope=stocks|markets|ecosystem`, `?ticker=`), `/api/news/digest` | Headlines (the ecosystem scope tags each title with the listed tickers it names), shared brief with the Base & Coinbase spotlight |
| `GET/POST /api/region`, `/api/config`, `/api/status`, `/api/health` | Region and attestation, public flags, live checks, metrics |
| `/api/auth/*` | SIWE nonce, verify, session |
| `/api/admin/*` | Discovery verification; `POST /api/admin/earn/reconcile` runs the Earn sweep now (`fromBlock`, `maxBlocks` optional) |

---

## 13. Operations

- **Schedules.** `.github/workflows/refresh.yml` calls the time-sensitive cron jobs (`index`, `verify`, `earn`, `pools`, `stats`, `status`) every 15 minutes, one request each; `keeper.yml` ticks the AutoInvest keeper every 15 minutes; `vercel.json` keeps the daily `all` run (discovery, cache sweep). `monitor.yml` reads `/api/health` every 30 minutes and fails the run — GitHub emails the owner — when `alerts` is not empty: keeper below 0.0005 ETH, a dependency down, 20+ errors in the last hour, a storage table missing.
- **Indexing.** `src/services/chain-index-service.ts`: a wallet is scanned once when it first opens its timeline (`registerWallet`: 120k blocks of `Transfer` logs for the 13 stocks, plus a one-time Earn reconciliation), then the `index` job reads every stock's transfers for the blocks mined since the last sweep — one `getLogs` per 10k blocks however many wallets there are — and keeps the rows touching an indexed wallet. A timeline read is a table lookup plus one bounded, shared look at the unswept tail.

- `/status` probes: Base RPC, Chainlink feed, DexScreener, GeckoTerminal, 0x, KyberSwap, OKX, Uniswap API, Velora, Aerodrome, Morpho, Aave, Compound, DEX pools, discovery, Basenames, Supabase, AI provider, news feeds, Builder Code. HTTP 429 is reported as degraded, not down.
- `/api/health` exposes the metrics registry (calls, errors, last error per counter, breaker opens) in non-production or with the admin token.
- `/stats` is the platform ledger: headline figures per window (24h / 7d / 30d / all), trading by stock and route, strategies (baskets, AutoInvest and manual plan runs, community baskets), gifts (direct, links, pools, valued at today's price), Earn by venue, people (wallets counted once), a 30-day chart, a verification block (verified / pending / reverted / no hash / duplicates collapsed) and the latest verified transactions with Basescan links. Rules: a transaction counts only with a `success` receipt; one (transaction, stock, side) is one trade, merged across trade rows and execution steps; a gift bought for someone is one trade and one gift.
- Checks used in development: `pnpm exec tsc --noEmit`, `pnpm exec eslint src`, `pnpm exec vitest run`, `pnpm exec next build`.

## 14. RPC and provider economy

- Public data is fetched once per window and shared: assets, prices, oracle state, OHLCV, pools, earn discovery and the shared AI brief all live in the in-process cache; ten visitors cost one upstream call per window, not ten. The cache is bounded (5,000 keys, swept every two minutes).
- Per-wallet data (balances, LP positions, the portfolio snapshot) is unavoidable per user but is also cached briefly per wallet (snapshot 15 s, LP 30 s) and invalidated when the app itself records a trade.
- The activity timeline no longer scans logs per wallet: transfers come from the app's own index (`chain_transfers`), filled by a sweep whose cost does not depend on the number of wallets, plus one shared look at the last few thousand blocks.
- What is the same for everyone (prices, assets, feeds, discovery, the statistics) is computed once per window across all serverless instances through the shared cache tier, not once per instance.
- Client polling is deliberately slow (balances 30 s, portfolio 45 s, activity 120 s, assets 30 s against the server cache) and pauses in background tabs through React Query defaults.
- Background work (market warm-up every 30 s, status probes every 5 min) runs only while a request arrived in the last 10 minutes (`src/lib/activity-pulse.ts`); an idle deployment makes no calls. Asset discovery (every 30 min) and the hourly 0x probe are the only unconditional jobs.
- Status checks are cached 60 s; a single failed probe shows as *degraded*, an *outage* needs two consecutive failures; the page shows the last 12 probe results per component.
