import { formatUnits, type Address, type Hash } from "viem";
import type { AutomationOnchain, AutomationRule, AutomationRunRecord } from "@/domain/community";
import { getRepos } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { cached, invalidate } from "@/lib/cache";
import { metrics } from "@/lib/http";
import { newId } from "@/lib/execution/portfolio-execution";
import { USDC_DECIMALS } from "@/config/chain";
import { validateAllocations } from "./portfolio-service";
import { isCuratedAsset, findCuratedAsset } from "@/lib/b20/registry";
import { AUTO_INVEST_ADDRESS, KNOWN_AUTO_INVEST_ADDRESSES, allocationsFromLegs, autoInvestAddressOf, intervalToCadenceDays, isAutoInvestDeployed, isKnownAutoInvest, usdcToUsd, type OnchainPlan, type PlanFunding } from "@/lib/auto-invest";
import { readFunding, readFundingMany, readOnchainPlan, readOnchainPlansOf } from "./auto-invest-chain";
import { verifyTrade } from "./tx-verify-service";

/**
 * Automation rules come in two kinds that must never be confused:
 *
 * - **Plans** (`recurring-buy`, `recurring-basket`) buy on a schedule. In `manual` mode the app
 *   proposes a due run and the owner confirms each trade; in `auto` mode the plan lives in the
 *   AutoInvest contract and the keeper (or the owner) triggers it, with the chain enforcing amount,
 *   cadence, route and output. An `auto` rule is only ever a mirror of the chain.
 * - **The target** (`drift-alert`) is the mix a wallet wants to hold. It has no schedule, is never
 *   run, and is edited from Portfolio → Rebalance. It is filtered out of every plan list.
 */
export interface CreateRuleInput {
  type: AutomationRule["type"];
  assetAddress?: Address;
  basketName?: string;
  allocations?: AutomationRule["config"]["allocations"];
  amountUsd?: number;
  cadenceDays?: number;
  thresholdBps?: number;
  templateId?: string;
  mode?: "manual" | "auto";
  /** Manual basket plans only: buy toward the allocations as a target instead of buying them as weights. */
  towardTarget?: boolean;
  /** Auto plans: the id the contract assigned, and the transaction that created it. */
  onchainPlanId?: string;
  txHash?: Hash;
  /**
   * Auto plans: the deployment the plan was created in. Normally the current contract; named
   * explicitly so a plan signed just before a contract switch is still mirrored from the right place.
   */
  onchainContract?: Address;
}

export const HISTORY_CAP = 30;
export const DEFAULT_THRESHOLD_BPS = 500;
/** A keeper run that is still marked as in progress after this long is treated as abandoned. */
export const RUN_LOCK_MS = 10 * 60_000;

export function isPlanRule(rule: Pick<AutomationRule, "type">): boolean {
  return rule.type === "recurring-buy" || rule.type === "recurring-basket";
}

export function isAutoRule(rule: Pick<AutomationRule, "config">): boolean {
  return rule.config.mode === "auto";
}

export async function createRule(owner: Address, input: CreateRuleInput): Promise<AutomationRule> {
  const now = Date.now();
  if (input.mode === "auto") {
    if (input.towardTarget) throw new AppError("BAD_REQUEST", "A toward-target plan is confirmed run by run; it cannot be automatic.", 400);
    return createAutoMirror(owner, input, now);
  }
  if (input.towardTarget && input.type !== "recurring-basket") throw new AppError("BAD_REQUEST", "A toward-target plan needs a target mix.", 400);
  const cadence = input.cadenceDays ?? 7;
  if (input.type === "recurring-buy") {
    if (!input.assetAddress || !isCuratedAsset(input.assetAddress)) throw new AppError("BAD_REQUEST", "Pick a verified stock.", 400);
    if (!input.amountUsd || input.amountUsd < 1) throw new AppError("BAD_REQUEST", "Amount must be at least $1.", 400);
  } else if (input.type === "recurring-basket") {
    if (!input.allocations?.length) throw new AppError("BAD_REQUEST", "Pick a basket.", 400);
    const v = validateAllocations(input.allocations);
    if (!v.ok) throw new AppError("BAD_REQUEST", v.errors.join(" "), 400);
    if (!input.amountUsd || input.amountUsd < 1) throw new AppError("BAD_REQUEST", "Amount must be at least $1.", 400);
  } else if (input.type === "drift-alert") {
    if (!input.templateId && !input.allocations?.length) throw new AppError("BAD_REQUEST", "Pick a target allocation.", 400);
    if (input.allocations?.length) {
      const v = validateAllocations(input.allocations);
      if (!v.ok) throw new AppError("BAD_REQUEST", v.errors.join(" "), 400);
    }
  }
  const rule: AutomationRule = {
    id: newId("auto"),
    owner,
    type: input.type,
    config: {
      assetAddress: input.assetAddress,
      basketName: input.basketName,
      allocations: input.allocations,
      amountUsd: input.amountUsd,
      cadenceDays: input.type === "drift-alert" ? undefined : cadence,
      thresholdBps: input.thresholdBps ?? DEFAULT_THRESHOLD_BPS,
      templateId: input.templateId,
      mode: input.type === "drift-alert" ? undefined : "manual",
      ...(input.towardTarget ? { towardTarget: true } : {}),
    },
    status: "active",
    nextRunAt: input.type === "drift-alert" ? undefined : now,
    createdAt: now,
    updatedAt: now,
  };
  return getRepos().automation.create(rule);
}

/**
 * An auto plan is created onchain first; the app only keeps a mirror so the UI has names, history
 * and a place to hang keeper errors. Everything about money and schedule is read from the chain.
 */
async function createAutoMirror(owner: Address, input: CreateRuleInput, now: number): Promise<AutomationRule> {
  if (!isAutoInvestDeployed()) throw new AppError("BAD_REQUEST", "Auto-invest is not enabled on this deployment.", 400);
  if (!input.onchainPlanId || !/^\d+$/.test(input.onchainPlanId)) throw new AppError("BAD_REQUEST", "Missing onchain plan id.", 400);
  // New plans are created in the current contract; a client may name a known one explicitly, never an arbitrary one.
  if (input.onchainContract && !isKnownAutoInvest(input.onchainContract)) throw new AppError("BAD_REQUEST", "That is not an AutoInvest contract this app knows.", 400);
  const contract = input.onchainContract ?? (AUTO_INVEST_ADDRESS as Address);
  const plan = await readOnchainPlan(contract, BigInt(input.onchainPlanId));
  if (!plan) throw new AppError("NOT_FOUND", "That plan does not exist onchain.", 404);
  if (plan.owner.toLowerCase() !== owner.toLowerCase()) throw new AppError("UNAUTHORIZED", "That plan belongs to another wallet.", 403);
  const existing = (await getRepos().automation.list(owner)).find((r) => samePlan(r, plan));
  if (existing) return existing;
  const funding = await readFunding(plan.contract, owner, plan.amountPerRun).catch(() => undefined);
  const rule = mirrorRule(owner, plan, funding, { basketName: input.basketName, createdTx: input.txHash }, now);
  return getRepos().automation.create(rule);
}

/** Plan ids start over in every deployment, so a mirror matches a plan only on (contract, id). */
function samePlan(rule: AutomationRule, plan: OnchainPlan): boolean {
  return rule.config.onchain?.planId === plan.planId.toString() && autoInvestAddressOf(rule).toLowerCase() === plan.contract.toLowerCase();
}

function mirrorOf(plan: OnchainPlan, funding: PlanFunding | undefined, createdTx?: Hash): AutomationOnchain {
  return {
    // Where the plan was read from, never the env: a legacy plan must not migrate on paper when the
    // contract new plans use changes underneath it.
    contract: plan.contract,
    planId: plan.planId.toString(),
    createdTx,
    syncedAt: Date.now(),
    status: plan.status,
    nextRunAt: plan.nextRunAt * 1000,
    lastRunAt: plan.lastRunAt * 1000,
    runs: plan.runs,
    amountPerRun: plan.amountPerRun.toString(),
    interval: plan.interval,
    expiryAt: plan.expiry * 1000,
    maxSlippageBps: plan.maxSlippageBps,
    funding,
  };
}

function mirrorRule(owner: Address, plan: OnchainPlan, funding: PlanFunding | undefined, extra: { basketName?: string; createdTx?: Hash }, now: number): AutomationRule {
  const single = plan.legs.length === 1;
  const allocations = allocationsFromLegs(plan.legs);
  return {
    id: newId("auto"),
    owner,
    type: single ? "recurring-buy" : "recurring-basket",
    config: {
      assetAddress: single ? plan.legs[0]!.asset : undefined,
      basketName: single ? undefined : (extra.basketName ?? `Plan #${plan.planId}`),
      allocations,
      amountUsd: usdcToUsd(plan.amountPerRun),
      cadenceDays: intervalToCadenceDays(plan.interval),
      mode: "auto",
      maxSlippageBps: plan.maxSlippageBps,
      expiryAt: plan.expiry ? plan.expiry * 1000 : undefined,
      onchain: mirrorOf(plan, funding, extra.createdTx),
      history: [],
    },
    status: plan.status,
    nextRunAt: plan.nextRunAt * 1000,
    lastRunAt: plan.lastRunAt ? plan.lastRunAt * 1000 : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

/** Bring a mirror in line with the chain; returns the patch to store, or null when nothing moved. */
export function mirrorPatch(rule: AutomationRule, plan: OnchainPlan, funding?: PlanFunding): Partial<AutomationRule> | null {
  const prev = rule.config.onchain;
  const next = mirrorOf(plan, funding ?? prev?.funding, prev?.createdTx);
  const changed =
    !prev ||
    // Mirrors written before the contract was recorded per plan pick it up on their first sync.
    (prev.contract ?? "").toLowerCase() !== next.contract.toLowerCase() ||
    prev.status !== next.status ||
    prev.nextRunAt !== next.nextRunAt ||
    prev.runs !== next.runs ||
    prev.amountPerRun !== next.amountPerRun ||
    prev.interval !== next.interval ||
    prev.expiryAt !== next.expiryAt ||
    prev.maxSlippageBps !== next.maxSlippageBps ||
    JSON.stringify(prev.funding ?? null) !== JSON.stringify(next.funding ?? null);
  if (!changed) return null;
  return {
    status: plan.status,
    nextRunAt: plan.nextRunAt * 1000,
    lastRunAt: plan.lastRunAt ? plan.lastRunAt * 1000 : rule.lastRunAt,
    config: {
      ...rule.config,
      amountUsd: usdcToUsd(plan.amountPerRun),
      cadenceDays: intervalToCadenceDays(plan.interval),
      maxSlippageBps: plan.maxSlippageBps,
      expiryAt: plan.expiry ? plan.expiry * 1000 : undefined,
      onchain: next,
    },
  };
}

/**
 * The wallet's rules with every auto plan refreshed from the chain — and any plan created onchain
 * that the app never heard about (a failed mirror request, another frontend) gets a mirror now.
 * Cached briefly per wallet so a page full of panels costs one set of reads.
 */
export async function listRulesSynced(owner: Address): Promise<AutomationRule[]> {
  const repos = getRepos();
  if (!isAutoInvestDeployed()) return repos.automation.list(owner);
  return cached(`automation:synced:${owner.toLowerCase()}`, { ttlMs: 15_000 }, async () => {
    // The wallet's plans in every deployment the app knows, current and legacy. A deployment that
    // does not answer is skipped for this read: its mirrors stay as they were rather than vanish.
    const [rules, ...perContract] = await Promise.all([repos.automation.list(owner), ...KNOWN_AUTO_INVEST_ADDRESSES.map((c) => readOnchainPlansOf(c, owner).catch(() => null))]);
    if (perContract.every((p) => p === null)) return rules;
    const plans = perContract.flatMap((p) => p ?? []);
    const out = [...rules];
    const key = (contract: Address, planId: string) => `${contract.toLowerCase()}:${planId}`;
    const byPlan = new Map(rules.filter((r) => r.config.onchain).map((r) => [key(autoInvestAddressOf(r), r.config.onchain!.planId), r]));
    // One multicall for every active plan's funding, instead of one round trip per plan in turn.
    const active = plans.filter((p) => p.status === "active");
    const fundings = await readFundingMany(active.map((p) => ({ contract: p.contract, owner, amountPerRun: p.amountPerRun }))).catch(() => [] as PlanFunding[]);
    const fundingByPlan = new Map(active.map((p, i) => [key(p.contract, p.planId.toString()), fundings[i]]));
    for (const plan of plans) {
      const funding = fundingByPlan.get(key(plan.contract, plan.planId.toString()));
      const rule = byPlan.get(key(plan.contract, plan.planId.toString()));
      if (!rule) {
        const created = await repos.automation.create(mirrorRule(owner, plan, funding, {}, Date.now()));
        out.push(created);
        continue;
      }
      const patch = mirrorPatch(rule, plan, funding);
      if (patch) {
        const updated = await repos.automation.update(rule.id, owner, patch);
        if (updated) out[out.indexOf(rule)] = updated;
      }
    }
    return out;
  });
}

export function invalidateRules(owner: Address): void {
  invalidate(`automation:synced:${owner.toLowerCase()}`);
}

/**
 * When the next run falls due, anchored on the time it was *scheduled* for rather than the moment
 * the user got round to confirming it.
 *
 * Anchoring on the confirmation slid the whole schedule: confirm a weekly plan three days late,
 * every week, and it quietly becomes a ten-day plan. Anchoring on the schedule keeps the cadence
 * the user asked for.
 *
 * The catch-up loop is the other half. Someone away for two months should come back to one run
 * waiting, not eight — a plan that buys $100 a week is not an instruction to spend $800 at once,
 * and nothing here should be able to queue that.
 */
export function nextRunAfter(scheduledFor: number | undefined, cadenceDays: number, now: number): number {
  const cadenceMs = Math.max(1, cadenceDays) * 24 * 3600_000;
  let next = (scheduledFor ?? now) + cadenceMs;
  while (next <= now) next += cadenceMs;
  return next;
}

/**
 * How many scheduled runs went by unconfirmed, the one already due included. Only ever reported —
 * a missed run is not carried forward and bought later, because the price it was meant to buy at
 * is gone.
 */
export function missedRuns(rule: AutomationRule, now = Date.now()): number {
  if (!isDue(rule, now)) return 0;
  const cadenceMs = Math.max(1, rule.config.cadenceDays ?? 7) * 24 * 3600_000;
  return Math.floor((now - rule.nextRunAt!) / cadenceMs) + 1;
}

export interface RunSummary {
  txHashes?: Hash[];
  spentUsd?: number;
  legs?: AutomationRunRecord["legs"];
  ok?: boolean;
  error?: string;
  inBalance?: boolean;
}

/**
 * What a manual run actually spent, from the chain rather than from the browser.
 *
 * The browser's `spentUsd` used to be written down as sent, and a plan's history feeds the
 * statistics. So: the verified trade rows on the run's hashes are summed first; a hash with no
 * row yet is read from its receipt (the USDC that left the wallet for that stock); a hash the
 * receipt does not vouch for contributes nothing. Null means nothing could be settled yet (the
 * receipts are still pending), and the caller falls back to the claim, bounded.
 */
async function settledRunUsd(owner: Address, hashes: readonly Hash[], legs: RunSummary["legs"]): Promise<number | null> {
  if (hashes.length === 0) return 0;
  const wanted = new Set(hashes.map((h) => h.toLowerCase()));
  const rows = (await getRepos().trades.listByOwner(owner, 500).catch(() => [])).filter((t) => t.txHash && wanted.has(t.txHash.toLowerCase()) && t.verifiedAt !== undefined && t.status !== "failed" && t.usdValue !== null);
  const seen = new Set<string>();
  let usd = 0;
  let settled = false;
  for (const t of rows) {
    const key = `${t.txHash!.toLowerCase()}:${t.assetAddress.toLowerCase()}:${t.side}`;
    if (seen.has(key)) continue;
    seen.add(key);
    usd += t.usdValue!;
    settled = true;
  }
  const covered = new Set(rows.map((t) => t.txHash!.toLowerCase()));
  // Hashes with no verified row: the receipt itself, one leg's stock at a time.
  for (const h of hashes) {
    if (covered.has(h.toLowerCase())) continue;
    const candidates = (legs ?? []).filter((l) => l.spentUsd > 0 && !l.skipped);
    for (const leg of candidates) {
      try {
        const v = await verifyTrade({ txHash: h, owner, assetAddress: leg.assetAddress, side: "buy" });
        if (!v.ok) continue;
        settled = true;
        if (v.usdcAmount !== null) usd += Number(formatUnits(v.usdcAmount, USDC_DECIMALS));
      } catch (err) {
        metrics.count("automation.run.settle", false, err instanceof Error ? err.message : String(err));
      }
    }
  }
  return settled ? Math.round(usd * 100) / 100 : null;
}

/**
 * Record that the owner ran a manual plan. Only a run that bought something moves the schedule: a
 * run rejected in the wallet stays due, so nothing is silently skipped.
 *
 * The amount recorded is what the chain shows was spent (see `settledRunUsd`); a claim above the
 * plan's own amount is refused outright, and a run that names no transaction spent nothing.
 */
export async function markRun(owner: Address, id: string, summary: RunSummary = {}): Promise<AutomationRule | null> {
  const rules = await getRepos().automation.list(owner);
  const rule = rules.find((r) => r.id === id);
  if (!rule) return null;
  if (!isPlanRule(rule)) throw new AppError("BAD_REQUEST", "Your target mix is not a plan; there is nothing to run.", 400);
  if (isAutoRule(rule)) throw new AppError("BAD_REQUEST", "Auto plans are run by the contract; the app does not mark them by hand.", 400);
  const now = Date.now();
  const cap = rule.config.amountUsd ?? 0;
  // A little over the plan's amount is rounding on a leg; a lot over is not this plan's run.
  if ((summary.spentUsd ?? 0) > cap * 1.05 + 1) throw new AppError("BAD_REQUEST", `A run of this plan spends at most ${cap.toFixed(2)} USD.`, 400);
  const hashes = [...new Set((summary.txHashes ?? []).map((h) => h.toLowerCase()))] as Hash[];
  const claimed = Math.min(summary.spentUsd ?? 0, cap);
  // Settled from the chain where it can be; a claim without a transaction is a claim of nothing.
  const fromChain = hashes.length === 0 ? 0 : await settledRunUsd(owner, hashes, summary.legs);
  const spentUsd = fromChain !== null ? Math.min(fromChain, cap * 1.05 + 1) : claimed;
  // A toward-target run that found the mix in balance did its job without buying: it counts, and the date moves on.
  const inBalance = summary.inBalance === true && !!rule.config.towardTarget;
  const ok = summary.ok !== false && (spentUsd > 0 || inBalance);
  const legs = summary.legs?.map((l) => ({ ...l, spentUsd: Math.min(l.spentUsd, cap) }));
  const record: AutomationRunRecord = { at: now, ok, via: "wallet", txHash: hashes[0], spentUsd, legs, error: ok ? undefined : (summary.error ?? "Nothing was bought."), ...(inBalance ? { note: "In balance — nothing under target, nothing bought." } : {}) };
  const history = [record, ...(rule.config.history ?? [])].slice(0, HISTORY_CAP);
  return getRepos().automation.update(id, owner, {
    ...(ok ? { lastRunAt: now, nextRunAt: nextRunAfter(rule.nextRunAt, rule.config.cadenceDays ?? 7, now) } : {}),
    config: { ...rule.config, history },
  });
}

/** Adjust how far the mix may drift before the portfolio says something. */
export async function setThreshold(owner: Address, id: string, thresholdBps: number): Promise<AutomationRule | null> {
  const rule = (await getRepos().automation.list(owner)).find((r) => r.id === id);
  if (!rule) return null;
  if (rule.type !== "drift-alert") throw new AppError("BAD_REQUEST", "Only the target mix has a drift threshold.", 400);
  return getRepos().automation.update(id, owner, { config: { ...rule.config, thresholdBps } });
}

/** Re-read one auto plan from the chain and store what changed (after the owner paused, resumed, cancelled or edited it). */
export async function syncRule(owner: Address, id: string): Promise<AutomationRule | null> {
  const rule = (await getRepos().automation.list(owner)).find((r) => r.id === id);
  if (!rule) return null;
  if (!rule.config.onchain) return rule;
  const plan = await readOnchainPlan(autoInvestAddressOf(rule), BigInt(rule.config.onchain.planId));
  if (!plan) return rule;
  const funding = plan.status === "active" ? await readFunding(plan.contract, owner, plan.amountPerRun).catch(() => undefined) : undefined;
  const patch = mirrorPatch(rule, plan, funding);
  invalidateRules(owner);
  return patch ? getRepos().automation.update(id, owner, patch) : rule;
}

export function isDue(rule: AutomationRule, now = Date.now()): boolean {
  if (!isPlanRule(rule)) return false;
  if (rule.status !== "active" || rule.nextRunAt === undefined || rule.nextRunAt > now) return false;
  if (rule.config.expiryAt && rule.config.expiryAt < now) return false;
  return true;
}

/** Display name for a plan row. */
export function ruleLabel(rule: AutomationRule): string {
  if (rule.type === "recurring-buy" && rule.config.assetAddress) return findCuratedAsset(rule.config.assetAddress)?.underlying ?? "stock";
  return rule.config.basketName ?? "basket";
}
