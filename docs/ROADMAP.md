# Roadmap

What is deliberately not built yet, in the order it would probably pay off. Everything here is optional; the product works without it. Dates are decision dates.

## Later / optional

- **Agent permissions** — Base Account Spend Permissions so due plans can run unattended within a cap the user sets (daily limit, expiry, listed stocks only); needs a server-side executor and its own safety review. The Automate page exists (2026-09-03); every run is still a wallet confirmation.

- **CoW Protocol as a trade provider** (deferred 2026-09-03). Keyless on Base and quotes B20 both ways (tested). It is a signed-order flow, not a swap transaction: approve the GPv2 vault relayer, sign an EIP-712 order (EIP-1271 for Base Account), post it, poll settlement, handle expiry. Worth it for large orders (solver competition, MEV protection) and gasless trades; today the three AMM routes are within 0.03% of each other.
- **LP Phase 2: add and manage liquidity in-app** (deferred 2026-09-03). Aerodrome Slipstream and Uniswap v3 position managers: exact approvals for both tokens, `mint` from a USD price range (tick math already in `src/lib/earn/lp-math.ts`; missing the inverse "amounts for a range" calculation), `increaseLiquidity`, `decreaseLiquidity` + `collect`, fee collection. Preview must show the range in USD per share, both amounts and the position value; simulate before signing. Uniswap v4 pools stay on the venue.
- **LP Phase 3** — stake Slipstream positions in the gauge for AERO emissions; unstake before removing.
- **Morpho borrow in-app** — `supplyCollateral` + `borrow`, health factor and liquidation warnings, repay and withdraw. Only useful once a Morpho market lists a B20 token as collateral (none today; discovery would show it automatically).
- **OKX DEX API** (reviewed 2026-09-03) — aggregator quotes/swaps and market data (price, candles, trades) for Base, but every endpoint needs an OKX Web3 developer API key, secret and passphrase (HMAC-signed headers; keyless calls answer 50103). Free tier exists. Add as a fifth trade provider and a market-data fallback once keys are in `.env`.
- **LI.FI SDK / widget** in-app instead of the hosted link (heavy dependency; the link already covers 20+ chains).
- **KyberSwap Earn / Zap**, **Beefy** and **Euler** discovery — more venues for the Earn scan if they ever list tokenized stocks.
- **0x opt-in** — email 0x (subject "xStocks Opt-in") to enable B20 on 0x; requires `GEOBLOCK_MODE=block`.
- **Drift alerts UI**, **E2E tests** (Playwright against the dev server), remaining spec gaps: firm quote shown in review, simulation on the batched path, MINT/BURN pause surface.

## Dropped

- **1inch** — needs an authenticated API key; not worth it while KyberSwap, Uniswap and Velora cover the same pools.
- **Coinbase Onramp** — not integrated by decision (2026-09-03); "From Coinbase" means withdrawing USDC on Base to the shown address.
- **Market trades tape** on the stock page — removed 2026-09-03; "Your trades" stays.

## Set at deploy time

- `NEXT_PUBLIC_BASE_BUILDER_CODE` (ERC-8021 Builder Code) once the app is on Vercel/GitHub.
- `GEOBLOCK_MODE` — `attest` (default, self-certification) or `block`.
