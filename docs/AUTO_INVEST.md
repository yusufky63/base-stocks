# AutoInvest — recurring purchases that run without you

**Base mainnet:** `0xc767844F2D65ba241DBe2c04f9c01d05cCD9b60E`, deployed 2026-09-05, source verified on Basescan. Owner `0x78de409a6306550882328E2a67160471368387FF`, keeper `0xffA71652A0a5a9A5b2CDB6AdFe6b753b1488c39C`, routers allowed from day one: KyberSwap `0x6131…37b5`, Aerodrome `0xcf77…4e43`, OKX `0x67d0…81df` (spender `0x57df…114e`). Feeds registered for every stock (`scripts/auto-invest-feeds.sh` re-syncs them). The two deploy scripts, `scripts/auto-invest-deploy.sh` and `scripts/auto-invest-feeds.sh`, are what produced this deployment.

`contracts/src/AutoInvest.sol` is the contract behind **Automate → Automatic**. A plan says how much USDC to spend per run, how often, into which stocks and in what proportion. When a run is due, the keeper (a BStocks server account) or the plan owner calls `execute`; the contract pulls one run's USDC from the owner under a normal ERC-20 allowance, swaps it through an allow-listed router with the owner as recipient, checks the owner actually received at least what was promised, and returns anything the router did not take. 31 Foundry tests (`contracts/test/AutoInvest.t.sol`), including a fuzz over per-leg amounts.

## What the chain enforces

| Rule | Where |
| --- | --- |
| Never more than `amountPerRun` per run; never more than a leg's weight per leg | `_checkCaps` → `LegTooLarge`, `NothingToBuy` |
| Never before `nextRunAt`; the anchor moves on the plan's own grid, so a plan paused for two months owes one run, not eight | `NotDue`, `_advance` (O(1) catch-up) |
| Expiry (0 = none) and status (active / paused / cancelled, cancel is terminal) | `PlanExpired`, `PlanNotActive`, `PlanIsCancelled` |
| Routers and approval targets are allow-listed; additions become usable 24 h after they are announced onchain, removals are immediate | `proposeAllowlist` / `applyAllowlist` / `revokeAllowlist`, `RouteNotAllowed` |
| The owner's stock balance must grow by more than zero, by at least the keeper's `minOut`, and — when a Chainlink feed is registered for the stock — by at least the reference price less the plan's `maxSlippageBps` (B20 multiplier aware, feeds older than 4 days ignored) | `_fill`, `quoteFloor`, `TooLittleReceived` |
| USDC enters and leaves inside one transaction; the contract never holds stock; leftovers go back to the owner | `_pull`, `_push`, `nonReentrant` |
| Only the keeper or the plan owner can run a plan; only the owner can pause, resume, edit or cancel it | `NotKeeper`, `NotPlanOwner` |

The operator (contract `owner`, 2-step transfer) can rotate the keeper, announce routes, and set feeds. A feed can only ever raise the bar a swap must clear; a malicious route needs the 24-hour announcement first, which is the window in which plan owners can pause or revoke.

## Deploy

Prerequisites: Foundry, a deployer key with a little ETH on Base, the keeper's address (a fresh EOA; its private key goes to the server as `AUTOMATION_KEEPER_KEY`).

1. Print the routes the app would use and the feeds to register (the app must be running, `pnpm dev` or the production URL):

   ```bash
   node scripts/auto-invest-routes.mjs http://localhost:3000
   ```

   It quotes a $1 buy of each live stock through every provider that supports a custom recipient and prints the distinct `transaction.to` (routers) and `allowanceSpender` (spenders) addresses, plus one `setFeed` per stock from `/api/assets`.

2. Deploy with those routers and spenders as the initial allow-list (they are announced by the deployment itself, no delay):

   ```bash
   cd contracts
   forge create src/AutoInvest.sol:AutoInvest \
     --rpc-url $BASE_RPC_URL --private-key $PRIVATE_KEY --broadcast \
     --constructor-args 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 <KEEPER_ADDRESS> "[<ROUTER>,<ROUTER>]" "[<SPENDER>,<SPENDER>]"
   forge verify-contract <ADDRESS> src/AutoInvest.sol:AutoInvest --chain base --etherscan-api-key $ETHERSCAN_API_KEY \
     --constructor-args $(cast abi-encode "constructor(address,address,address[],address[])" 0x8335…2913 <KEEPER> "[…]" "[…]")
   ```

3. Register the reference feeds (the floor is optional per stock but is the point of the design):

   ```bash
   cast send <ADDRESS> "setFeed(address,address)" <STOCK> <CHAINLINK_FEED> --rpc-url $BASE_RPC_URL --private-key $PRIVATE_KEY
   ```

4. Fund the keeper with ETH (a run costs well under a cent on Base; 0.01 ETH lasts a long time). The keeper refuses to tick below 0.0003 ETH and says so in the cron response.

5. Environment (Vercel → Settings → Environment Variables, then redeploy):

   | Variable | Value |
   | --- | --- |
   | `NEXT_PUBLIC_AUTO_INVEST_ADDRESS` | the deployed address; unset hides the Automatic option entirely |
   | `AUTOMATION_KEEPER_KEY` | the keeper's private key (server-only); unset means owners run due plans themselves from the app |
   | `AUTOMATION_MAX_RUNS_PER_TICK` | optional, default 6 |
   | `CRON_SECRET` | already required for `/api/cron/refresh`; the keeper tick uses the same bearer token |

6. Schedule the tick. `vercel.json` carries a daily entry (Hobby plans allow no more); `.github/workflows/keeper.yml` calls the endpoint every 15 minutes with the repository secrets `CRON_SECRET` and, optionally, `APP_URL`. Either caller works, both can run at once: a plan is locked while it executes and the contract refuses a second run inside the cadence regardless.

## Adding a route later

```bash
cast send <ADDRESS> "proposeAllowlist(uint8,address)" 0 <ROUTER>   # 0 = router, 1 = spender
# 24 hours later
cast send <ADDRESS> "applyAllowlist(uint8,address)" 0 <ROUTER>
```

Removal (`revokeAllowlist`) is immediate. The keeper only ever uses routes the contract already accepts: it reads `routerAllowed` / `spenderAllowed` for every quote and walks the provider list (KyberSwap → Velora → Aerodrome → OKX) until one is accepted.

## How a tick works (`src/services/auto-invest-keeper.ts`)

1. Every active `auto` rule is read; its onchain plan is refreshed into the mirror (`config.onchain`).
2. Plans that are active, not expired, due, not locked and not in a retry back-off are checked for funding (USDC balance and allowance ≥ one run). Underfunded plans get a `lastError` and a 6-hour back-off.
3. For a due plan, one swap per leg is built: legs the shared eligibility rule refuses today (not issued, no pool, paused, more than 2% of the pool) are skipped; the rest are quoted with `taker = contract`, `recipient = owner`, `orders: false`, through an allow-listed route; the contract's `quoteFloor` is read and a leg whose quote falls under it is skipped.
4. The whole run is simulated with the keeper account. `TooLittleReceived(leg, …)` drops that one leg and simulates again; any other revert is recorded with its decoded reason and a 1-hour back-off.
5. The run is sent and its receipt parsed: `LegFilled` events become trade records (Activity, cost basis), `PlanExecuted` becomes a history entry on the rule, and the mirror is refreshed from the chain.

The tick's JSON answer lists what it checked, executed and failed, plus the keeper's ETH balance — useful in a cron dashboard or a Slack hook.

## Owner-side runs

`POST /api/automation/prepare-run` builds the same swaps for the signed-in owner, who then sends `execute` from their own wallet (the app does this behind **Run now**). Useful when no keeper is configured or when the owner does not want to wait for the next tick. The app records the run from its receipt exactly like a keeper run (`PATCH /api/automation` with `action: "ran-onchain"`).

## Dry run on mainnet state (no transaction)

B20 stocks are native precompiles, so an anvil fork cannot execute them. `eth_simulateV1` on a real Base node can, and `src/services/auto-invest.simulate.test.ts` uses it to do everything a deployment would in one simulated block: deploy the contract, register the NVDA feed, lend the owner USDC from a large holder, approve, create a weekly $25 plan, run it with live aggregator calldata, read the owner's NVDAc balance before and after, check the contract's reference floor, and confirm a second run inside the week is refused (`NotDue`). Nothing is signed or sent.

```bash
SIMULATE_MAINNET=1 BASE_RPC_URL=<keyed or public Base RPC> OWNER=<your address> pnpm vitest run src/services/auto-invest.simulate.test.ts --reporter=verbose --silent=false
```

Run it before deploying, and again whenever a provider adapter or the contract changes. It is skipped in CI (opt-in by the environment variable).

## Threat model, briefly

- **Keeper key leaks**: the attacker can run due plans early-but-not-before-due, through allowed routes only, at outputs the contract's floor accepts. They cannot change amounts, cadence, recipients or legs, and cannot touch plans that are not due. Rotate with `setKeeper`.
- **Operator key leaks**: the attacker can announce a route (24 h public notice), change feeds (which can only tighten or remove the floor, never move funds) and rotate the keeper. Owners keep the ability to pause, cancel and revoke throughout.
- **Bad aggregator calldata**: the balance-delta check judges the outcome by what the owner holds afterwards, not by what the router claims.
- **A stock's pool disappears**: the leg is skipped that day; its share stays in the wallet; the plan keeps its schedule.
- **A stock's pool trades far above its Chainlink reference** (a thin pool at a 30–40% premium is a real state of the Base listings): the quote falls under `quoteFloor`, the keeper skips the leg with "pool price is further from the Chainlink reference than the plan allows", and the plan wizard, the basket editor and the AI drafts all name the premium beforehand (`referenceGapNote`, `premiumBeyondFloor` in `src/lib/trading-status.ts`).
