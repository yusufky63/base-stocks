import { formatEther, parseEventLogs, type Address, type Hash } from "viem";
import { BASE_CHAIN_ID, MIN_TRADE_USD } from "@/config/chain";
import { serverEnv } from "@/config/env";
import type { AutomationRule, AutomationRunLeg, AutomationRunRecord } from "@/domain/community";
import type { TradeProviderId } from "@/domain/trade";
import { getRepos } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";
import { newId } from "@/lib/execution/portfolio-execution";
import { buyLegBlockedReason, tradingStatus } from "@/lib/trading-status";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { getKeeperWalletClient, keeperAccount } from "@/lib/viem/keeper-client";
import { AUTO_INVEST_ADDRESS, autoInvestAbi, decodeAutoInvestError, isAutoInvestDeployed, legAmountIn, skippedSwap, usdcToUsd, type AutoInvestSwap, type OnchainPlan } from "@/lib/auto-invest";
import { getAssets } from "./b20-asset-service";
import { getPriceViews } from "./price-service";
import { tradeRouter } from "./trade-router";
import { invalidatePortfolioSnapshot } from "./portfolio-service";
import { HISTORY_CAP, RUN_LOCK_MS, invalidateRules, mirrorPatch } from "./automation-service";
import { readFloor, readFunding, readOnchainPlan, readOnchainPlans, readRouteAllowed } from "./auto-invest-chain";

/**
 * The keeper: finds auto plans that are due, builds one swap per leg from live quotes with the
 * owner as recipient, simulates the whole run, sends it, and records what the chain says happened.
 *
 * It decides *when* (within the cadence) and *through which route* (within the allow-list). The
 * contract decides everything else, so a keeper bug or a compromised key can at worst delay a run or
 * pick a worse allowed route, never move more than a plan permits or send stock anywhere but the
 * owner's wallet.
 */

/** Providers tried in order when the best quote's route is not on the contract's allow-list. */
const FALLBACK_PROVIDERS: TradeProviderId[] = ["kyber", "velora", "aerodrome", "okx"];
/** Below this the keeper refuses to spend gas it cannot replace. */
const MIN_KEEPER_ETH = 0.0003;
/** Wait before retrying a plan whose run failed for a reason that will not clear in a minute. */
const RETRY_AFTER_MS = 60 * 60_000;
const FUNDING_RETRY_MS = 6 * 60 * 60_000;
/** Rules read per page by the keeper; small enough that one page's plan reads fit in a multicall. */
const KEEPER_PAGE = 100;

export interface PlannedLeg {
  index: number;
  assetAddress: Address;
  symbol: string;
  amountIn: bigint;
  usd: number;
  provider?: string;
  expectedOut?: bigint;
  skipped?: string;
}

export interface RunPlanResult {
  legs: PlannedLeg[];
  swaps: AutoInvestSwap[];
  /** USDC base units the run will pull. */
  total: bigint;
}

/**
 * One swap per leg. A leg is skipped — its share stays in the wallet — when the stock cannot be
 * bought today (not issued, no pool, paused, too thin for the size), when no allow-listed route
 * quotes it, or when the best route falls under the contract's reference floor.
 */
export async function buildRunSwaps(plan: OnchainPlan, opts: { skipIndexes?: Set<number> } = {}): Promise<RunPlanResult> {
  const assets = await getAssets();
  const views = await getPriceViews(assets);
  const contract = AUTO_INVEST_ADDRESS as Address;
  const legs: PlannedLeg[] = [];
  const swaps: AutoInvestSwap[] = [];
  let total = 0n;

  for (let i = 0; i < plan.legs.length; i++) {
    const leg = plan.legs[i]!;
    const asset = assets.find((a) => a.canonicalId === leg.asset.toLowerCase());
    const amountIn = legAmountIn(plan.amountPerRun, leg.weightBps);
    const usd = usdcToUsd(amountIn);
    const planned: PlannedLeg = { index: i, assetAddress: leg.asset, symbol: asset?.symbol ?? leg.asset.slice(0, 8), amountIn, usd };
    const skip = (why: string) => {
      planned.skipped = why;
      planned.amountIn = 0n;
      legs.push(planned);
      swaps.push(skippedSwap());
    };

    if (opts.skipIndexes?.has(i)) {
      skip("the route delivered less than the plan allows");
      continue;
    }
    if (!asset || asset.status !== "active") {
      skip("not a tradable stock right now");
      continue;
    }
    if (usd < MIN_TRADE_USD) {
      skip(`$${usd.toFixed(2)} share is under the $${MIN_TRADE_USD} per-leg minimum; raise the amount per run to include it`);
      continue;
    }
    const view = views.get(asset.canonicalId) ?? null;
    const blocked = buyLegBlockedReason(tradingStatus({ status: asset.status, totalSupply: asset.totalSupply.toString() }, view ? { liquidityUsd: view.liquidityUsd, volume24hUsd: view.volume24hUsd } : null).status, usd, view?.liquidityUsd);
    if (blocked) {
      skip(blocked);
      continue;
    }

    const quote = await quoteAllowedRoute(contract, plan.owner, leg.asset, amountIn, plan.maxSlippageBps);
    if ("error" in quote) {
      skip(quote.error);
      continue;
    }
    const floor = await readFloor(leg.asset, amountIn, plan.maxSlippageBps).catch(() => 0n);
    // The contract answers 0 when the leg has no usable feed (none registered, or the answer is
    // older than its four-day limit) and then enforces only the route's own minOut. For a stock
    // that *has* a reference feed that is not a price check, it is the absence of one: a keeper
    // key in the wrong hands could route through an allow-listed router at minOut 1 and take the
    // difference. Such a leg waits for the feed rather than running without it.
    if (floor === 0n && asset.oracle) {
      skip("the contract's reference floor is unavailable (feed stale or not registered); the leg waits rather than run unchecked");
      continue;
    }
    if (floor > 0n && quote.buyAmount < floor) {
      skip("pool price is further from the Chainlink reference than the plan allows");
      continue;
    }
    planned.provider = quote.provider;
    planned.expectedOut = quote.buyAmount;
    legs.push(planned);
    swaps.push({ target: quote.to, spender: quote.spender, amountIn, minOut: quote.minOut > floor ? quote.minOut : floor, data: quote.data });
    total += amountIn;
  }
  return { legs, swaps, total };
}

type RouteQuote = { provider: string; to: Address; spender: Address; data: `0x${string}`; buyAmount: bigint; minOut: bigint } | { error: string };

/** Best quote whose router and spender the contract accepts; walks the provider list otherwise. */
async function quoteAllowedRoute(taker: Address, recipient: Address, assetAddress: Address, sellAmount: bigint, slippageBps: number): Promise<RouteQuote> {
  const tried = new Set<string>();
  let lastError = "no route";
  const attempt = async (provider?: TradeProviderId): Promise<RouteQuote | null> => {
    try {
      const q = await tradeRouter.quote({ side: "buy", assetAddress, sellAmount, taker, recipient, orders: false, noZeroX: true, slippageBps, chainId: BASE_CHAIN_ID, provider, strictProvider: !!provider });
      tried.add(q.provider);
      if (!q.transaction || q.transaction.value !== "0") return null;
      if (!q.allowanceSpender) return null;
      const allowed = await readRouteAllowed(q.transaction.to, q.allowanceSpender);
      if (!allowed.router || !allowed.spender) {
        lastError = `${q.provider} is not on the contract's allow-list`;
        return null;
      }
      const buyAmount = BigInt(q.buyAmount);
      const minOut = q.minBuyAmount ? BigInt(q.minBuyAmount) : (buyAmount * BigInt(10_000 - slippageBps)) / 10_000n;
      return { provider: q.provider, to: q.transaction.to, spender: q.allowanceSpender, data: q.transaction.data, buyAmount, minOut };
    } catch (err) {
      lastError = err instanceof AppError ? err.message : err instanceof Error ? err.message : String(err);
      return null;
    }
  };
  const best = await attempt();
  if (best) return best;
  for (const p of FALLBACK_PROVIDERS) {
    if (tried.has(p)) continue;
    const q = await attempt(p);
    if (q) return q;
  }
  return { error: lastError };
}

/* ------------------------------ execution ------------------------------ */

export interface RunOutcome {
  ok: boolean;
  txHash?: Hash;
  spentUsd?: number;
  legs: AutomationRunLeg[];
  error?: string;
  /** A failure the next tick should not retry immediately. */
  retryAfterMs?: number;
  /** The leg the contract rejected in simulation for delivering too little (`TooLittleReceived`). */
  failingLeg?: number;
  /** Sent, not yet mined when the tick ran out: not a failure, and not to be recorded as one. */
  pending?: boolean;
}

/** How long a sent run may stay unmined before it is written off; Base includes a paid transaction within seconds, so this is generous. */
const PENDING_RUN_GRACE_MS = 2 * 60 * 60_000;

/**
 * Simulate, send and confirm one run. Never throws: every outcome is a record.
 *
 * `onSent` fires with the hash the moment the transaction leaves the keeper, before the receipt
 * is awaited: a tick that ran out of time waiting (150 s of waiting inside a 60 s serverless
 * budget) used to return with nothing written, and a purchase that had in fact gone through showed
 * up in Activity as an unexplained transfer with no cost behind it. The hash persisted here is what
 * the next tick reconciles from the chain.
 */
export async function executeRun(plan: OnchainPlan, prepared: RunPlanResult, hooks: { onSent?: (txHash: Hash) => Promise<void> } = {}): Promise<RunOutcome> {
  const wallet = getKeeperWalletClient();
  const account = keeperAccount();
  const client = getServerPublicClient();
  const address = AUTO_INVEST_ADDRESS as Address;
  const legRecords = (): AutomationRunLeg[] => prepared.legs.map((l) => ({ assetAddress: l.assetAddress, symbol: l.symbol, spentUsd: l.skipped ? 0 : l.usd, provider: l.provider, skipped: l.skipped }));
  if (!wallet || !account) return { ok: false, legs: legRecords(), error: "No keeper is configured on this server.", retryAfterMs: RETRY_AFTER_MS };
  if (prepared.total === 0n) return { ok: false, legs: legRecords(), error: prepared.legs.map((l) => `${l.symbol}: ${l.skipped}`).join("; ") || "Nothing to buy.", retryAfterMs: RETRY_AFTER_MS };

  let simulation;
  try {
    simulation = await client.simulateContract({ address, abi: autoInvestAbi, functionName: "execute", args: [plan.planId, prepared.swaps], account });
  } catch (err) {
    const decoded = decodeAutoInvestError(err);
    metrics.count("automation.simulate", false, decoded?.name ?? (err instanceof Error ? err.message : String(err)));
    const failingLeg = decoded?.name === "TooLittleReceived" && typeof decoded.args[0] === "bigint" ? Number(decoded.args[0]) : undefined;
    return { ok: false, legs: legRecords(), error: decoded?.message ?? (err instanceof Error ? err.message.split("\n")[0]! : String(err)), retryAfterMs: decoded?.name === "TransferFailed" ? FUNDING_RETRY_MS : RETRY_AFTER_MS, failingLeg };
  }

  let hash: Hash;
  try {
    hash = await wallet.writeContract(simulation.request);
  } catch (err) {
    metrics.count("automation.send", false, err instanceof Error ? err.message : String(err));
    return { ok: false, legs: legRecords(), error: `Could not send the run: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, retryAfterMs: RETRY_AFTER_MS };
  }
  await hooks.onSent?.(hash).catch((err) => metrics.count("automation.pending.write", false, err instanceof Error ? err.message : String(err)));

  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 40_000 }).catch(() => null);
  if (!receipt) return { ok: false, pending: true, txHash: hash, legs: legRecords(), error: "The run was sent; its receipt had not arrived when this tick ended. The next tick records it from the chain." };
  if (receipt.status !== "success") {
    metrics.count("automation.run", false, "reverted");
    return { ok: false, txHash: hash, legs: legRecords(), error: "The run reverted onchain; no USDC moved.", retryAfterMs: RETRY_AFTER_MS };
  }

  const filled = parseEventLogs({ abi: autoInvestAbi, logs: receipt.logs, eventName: "LegFilled" });
  const executed = parseEventLogs({ abi: autoInvestAbi, logs: receipt.logs, eventName: "PlanExecuted" })[0];
  const legs: AutomationRunLeg[] = prepared.legs.map((l) => {
    const f = filled.find((e) => e.args.asset.toLowerCase() === l.assetAddress.toLowerCase());
    return { assetAddress: l.assetAddress, symbol: l.symbol, spentUsd: f ? usdcToUsd(f.args.spent) : 0, received: f?.args.received.toString(), provider: l.provider, skipped: f ? undefined : (l.skipped ?? "skipped") };
  });
  metrics.count("automation.run", true, `plan ${plan.planId} spent ${executed ? usdcToUsd(executed.args.spent).toFixed(2) : "?"}`);
  return { ok: true, txHash: hash, spentUsd: executed ? usdcToUsd(executed.args.spent) : legs.reduce((s, l) => s + l.spentUsd, 0), legs };
}

/**
 * A run the owner sent from their own wallet, reconstructed from its receipt so it is recorded
 * exactly like a keeper run: trades for the cost basis, a history entry for the plan.
 */
export async function outcomeFromReceipt(plan: OnchainPlan, txHash: Hash, reasons: Map<string, string> = new Map()): Promise<RunOutcome> {
  const client = getServerPublicClient();
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (receipt.to?.toLowerCase() !== (AUTO_INVEST_ADDRESS as string).toLowerCase()) throw new AppError("BAD_REQUEST", "That transaction did not call the AutoInvest contract.", 400);
  const assets = await getAssets();
  const symbolOf = (a: Address) => assets.find((x) => x.canonicalId === a.toLowerCase())?.symbol ?? a.slice(0, 8);
  if (receipt.status !== "success") return { ok: false, txHash, legs: [], error: "The run reverted onchain; no USDC moved." };
  const filled = parseEventLogs({ abi: autoInvestAbi, logs: receipt.logs, eventName: "LegFilled" }).filter((e) => e.args.planId === plan.planId);
  const skipped = parseEventLogs({ abi: autoInvestAbi, logs: receipt.logs, eventName: "LegSkipped" }).filter((e) => e.args.planId === plan.planId);
  const executed = parseEventLogs({ abi: autoInvestAbi, logs: receipt.logs, eventName: "PlanExecuted" }).find((e) => e.args.planId === plan.planId);
  if (!executed) throw new AppError("BAD_REQUEST", "That transaction did not run this plan.", 400);
  const legs: AutomationRunLeg[] = [
    ...filled.map((e) => ({ assetAddress: e.args.asset, symbol: symbolOf(e.args.asset), spentUsd: usdcToUsd(e.args.spent), received: e.args.received.toString() })),
    ...skipped.map((e) => ({ assetAddress: e.args.asset, symbol: symbolOf(e.args.asset), spentUsd: 0, skipped: reasons.get(e.args.asset.toLowerCase()) ?? "could not be bought that day" })),
  ];
  return { ok: true, txHash, spentUsd: usdcToUsd(executed.args.spent), legs };
}

/** Trade records give the run a place in Activity and in the cost basis; the rule keeps the story. */
export async function recordRun(rule: AutomationRule, plan: OnchainPlan, outcome: RunOutcome, via: AutomationRunRecord["via"]): Promise<void> {
  const repos = getRepos();
  const now = Date.now();
  if (outcome.ok && outcome.txHash) {
    for (const leg of outcome.legs) {
      if (leg.skipped || leg.spentUsd <= 0) continue;
      await repos.trades
        .create({
          id: newId("trade"),
          owner: rule.owner,
          side: "buy",
          assetAddress: leg.assetAddress,
          sellAmount: BigInt(Math.round(leg.spentUsd * 1e6)).toString(),
          buyAmount: leg.received ?? "0",
          usdValue: Math.round(leg.spentUsd * 100) / 100,
          provider: leg.provider ?? "auto-invest",
          txHash: outcome.txHash,
          status: "confirmed",
          createdAt: now,
          // Written from the run's own `LegFilled` logs: verified by construction.
          verifiedAt: now,
        })
        .catch(() => undefined);
    }
    invalidatePortfolioSnapshot(rule.owner);
  }
  const record: AutomationRunRecord = { at: now, ok: outcome.ok, via, txHash: outcome.txHash, spentUsd: outcome.spentUsd, legs: outcome.legs, error: outcome.error };
  const after = (await readOnchainPlan(plan.planId).catch(() => null)) ?? plan;
  const funding = await readFunding(rule.owner, after.amountPerRun).catch(() => undefined);
  const patch = mirrorPatch(rule, after, funding) ?? {};
  const config = { ...(patch.config ?? rule.config) };
  config.history = [record, ...(rule.config.history ?? [])].slice(0, HISTORY_CAP);
  config.runningSince = undefined;
  config.pendingRun = undefined;
  config.lastError = outcome.ok ? undefined : { at: now, message: outcome.error ?? "The run failed.", retryAt: now + (outcome.retryAfterMs ?? RETRY_AFTER_MS) };
  await repos.automation.update(rule.id, rule.owner, { ...patch, config });
  invalidateRules(rule.owner);
}

/* ------------------------------ the tick ------------------------------ */

export interface KeeperReport {
  enabled: boolean;
  reason?: string;
  keeper?: Address;
  keeperEth?: string;
  checked: number;
  executed: Array<{ ruleId: string; planId: string; txHash: Hash; spentUsd: number }>;
  failed: Array<{ ruleId: string; planId: string; error: string }>;
  /** Runs sent and still unmined when the tick ended, or finished this tick from an earlier one's hash. */
  pending: Array<{ ruleId: string; planId: string; txHash: Hash; state: "sent" | "waiting" | "recorded" | "dropped" }>;
  ms: number;
}

/**
 * Finish a run an earlier tick sent but could not wait for: the receipt is read from the chain
 * and recorded exactly like a run that confirmed in time. A hash the chain still has not mined
 * after the grace period is written off, and the plan goes back to its schedule.
 */
async function finishPendingRun(rule: AutomationRule, plan: OnchainPlan, now: number): Promise<"waiting" | "recorded" | "dropped"> {
  const pending = rule.config.pendingRun!;
  const receipt = await getServerPublicClient().getTransactionReceipt({ hash: pending.txHash }).catch(() => null);
  if (!receipt) {
    if (now - pending.at < PENDING_RUN_GRACE_MS) return "waiting";
    await recordRun(rule, plan, { ok: false, txHash: pending.txHash, legs: [], error: "The run was sent but the network never mined it; nothing was bought.", retryAfterMs: RETRY_AFTER_MS }, "keeper");
    return "dropped";
  }
  const outcome = await outcomeFromReceipt(plan, pending.txHash).catch((err): RunOutcome => ({ ok: false, txHash: pending.txHash, legs: [], error: err instanceof Error ? err.message : String(err), retryAfterMs: RETRY_AFTER_MS }));
  await recordRun(rule, plan, outcome, "keeper");
  return "recorded";
}

/**
 * One keeper tick: every active auto plan is read from the chain, mirrors are refreshed, and due
 * plans are run — at most `limit` per tick so a serverless invocation stays inside its budget; the
 * rest wait for the next tick, which the contract's own cadence makes harmless.
 */
export async function runDuePlans(opts: { limit?: number; now?: number } = {}): Promise<KeeperReport> {
  const started = Date.now();
  const now = opts.now ?? started;
  const limit = opts.limit ?? serverEnv().AUTOMATION_MAX_RUNS_PER_TICK;
  const report: KeeperReport = { enabled: true, checked: 0, executed: [], failed: [], pending: [], ms: 0 };
  if (!isAutoInvestDeployed()) return { ...report, enabled: false, reason: "NEXT_PUBLIC_AUTO_INVEST_ADDRESS is not set", ms: Date.now() - started };
  const account = keeperAccount();
  if (!account) return { ...report, enabled: false, reason: "AUTOMATION_KEEPER_KEY is not set", ms: Date.now() - started };
  report.keeper = account.address;

  const client = getServerPublicClient();
  const eth = Number(formatEther(await client.getBalance({ address: account.address }).catch(() => 0n)));
  report.keeperEth = eth.toFixed(5);
  if (eth < MIN_KEEPER_ETH) {
    metrics.count("automation.keeper.gas", false, `${eth} ETH`);
    return { ...report, enabled: false, reason: `keeper ${account.address} holds ${eth.toFixed(5)} ETH; top it up`, ms: Date.now() - started };
  }

  const repos = getRepos();
  // Every active auto plan, a page at a time: a fixed cap of 200 meant plan #201 never ran.
  for (let offset = 0; ; offset += KEEPER_PAGE) {
    const rules = await repos.automation.listAuto(KEEPER_PAGE, offset);
    if (rules.length === 0) break;
    const withPlan = rules.filter((r) => r.config.onchain);
    // One multicall for the page's plans instead of one round trip per rule.
    const plans = await readOnchainPlans(withPlan.map((r) => BigInt(r.config.onchain!.planId))).catch(() => withPlan.map(() => null));
    const planByRule = new Map(withPlan.map((r, i) => [r.id, plans[i] ?? null]));
    for (const rule of rules) {
      if (report.executed.length + report.failed.length >= limit) break;
      const onchain = rule.config.onchain;
      if (!onchain) continue;
      report.checked += 1;
      const plan = planByRule.get(rule.id) ?? null;
      if (!plan) continue;
      const patch = mirrorPatch(rule, plan);
      if (patch) await repos.automation.update(rule.id, rule.owner, patch).catch(() => undefined);

      // A run an earlier tick sent and could not wait for comes first: until it is recorded, the
      // plan is neither due nor free.
      if (rule.config.pendingRun) {
        const state = await finishPendingRun(rule, plan, now).catch(() => "waiting" as const);
        report.pending.push({ ruleId: rule.id, planId: onchain.planId, txHash: rule.config.pendingRun.txHash, state });
        continue;
      }
      if (plan.status !== "active") continue;
      if (plan.expiry !== 0 && plan.expiry * 1000 < now) continue;
      if (plan.nextRunAt * 1000 > now) continue;
      if (rule.config.runningSince && now - rule.config.runningSince < RUN_LOCK_MS) continue;
      if (rule.config.lastError?.retryAt && rule.config.lastError.retryAt > now) continue;

      const funding = await readFunding(rule.owner, plan.amountPerRun).catch(() => undefined);
      if (funding && !funding.enough) {
        const message = BigInt(funding.usdcBalance) < plan.amountPerRun ? "Not enough USDC in the wallet for this run." : "The USDC allowance no longer covers a run; approve more to continue.";
        await repos.automation.update(rule.id, rule.owner, { config: { ...rule.config, onchain: { ...onchain, funding }, lastError: { at: now, message, retryAt: now + FUNDING_RETRY_MS } } }).catch(() => undefined);
        report.failed.push({ ruleId: rule.id, planId: onchain.planId, error: message });
        continue;
      }

      // Take the lock in one statement. Two ticks can land on the same plan (the fifteen-minute
      // schedule and the daily cron overlap; a delayed schedule can bunch up), and both used to read
      // "not running", both simulate, both send, and one paid gas to revert with NotDue.
      const running = { ...rule.config, runningSince: now };
      const claimed = await repos.automation.claimRun(rule.id, rule.owner, running, rule.config.runningSince ?? null).catch(() => false);
      if (!claimed) continue;
      const locked: AutomationRule = { ...rule, config: running };
      const onSent = async (txHash: Hash) => {
        await repos.automation.update(rule.id, rule.owner, { config: { ...running, pendingRun: { txHash, at: Date.now() } } });
      };
      let prepared = await buildRunSwaps(plan);
      let outcome = await executeRun(plan, prepared, { onSent });
      // A leg that undercuts the reference floor is dropped once and the rest of the run goes ahead.
      if (!outcome.ok && !outcome.pending && outcome.failingLeg !== undefined && prepared.total > 0n) {
        prepared = await buildRunSwaps(plan, { skipIndexes: new Set([outcome.failingLeg]) });
        outcome = await executeRun(plan, prepared, { onSent });
      }
      if (outcome.pending && outcome.txHash) {
        // The hash is already persisted by `onSent`; the plan stays locked until the next tick reads the receipt.
        report.pending.push({ ruleId: rule.id, planId: onchain.planId, txHash: outcome.txHash, state: "sent" });
        continue;
      }
      await recordRun(locked, plan, outcome, "keeper");
      if (outcome.ok && outcome.txHash) report.executed.push({ ruleId: rule.id, planId: onchain.planId, txHash: outcome.txHash, spentUsd: outcome.spentUsd ?? 0 });
      else report.failed.push({ ruleId: rule.id, planId: onchain.planId, error: outcome.error ?? "failed" });
    }
    if (rules.length < KEEPER_PAGE || report.executed.length + report.failed.length >= limit) break;
  }
  report.ms = Date.now() - started;
  return report;
}
