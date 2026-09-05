import type { Address, Hash } from "viem";
import type { AutomationOnchain, AutomationRule, AutomationRunRecord } from "@/domain/community";
import { getRepos } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { cached, invalidate } from "@/lib/cache";
import { newId } from "@/lib/execution/portfolio-execution";
import { validateAllocations } from "./portfolio-service";
import { isCuratedAsset, findCuratedAsset } from "@/lib/b20/registry";
import { AUTO_INVEST_ADDRESS, allocationsFromLegs, intervalToCadenceDays, isAutoInvestDeployed, usdcToUsd, type OnchainPlan, type PlanFunding } from "@/lib/auto-invest";
import { readFunding, readOnchainPlan, readOnchainPlansOf } from "./auto-invest-chain";

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
  /** Auto plans: the id the contract assigned, and the transaction that created it. */
  onchainPlanId?: string;
  txHash?: Hash;
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
  if (input.mode === "auto") return createAutoMirror(owner, input, now);
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
  const plan = await readOnchainPlan(BigInt(input.onchainPlanId));
  if (!plan) throw new AppError("NOT_FOUND", "That plan does not exist onchain.", 404);
  if (plan.owner.toLowerCase() !== owner.toLowerCase()) throw new AppError("UNAUTHORIZED", "That plan belongs to another wallet.", 403);
  const existing = (await getRepos().automation.list(owner)).find((r) => r.config.onchain?.planId === input.onchainPlanId);
  if (existing) return existing;
  const funding = await readFunding(owner, plan.amountPerRun).catch(() => undefined);
  const rule = mirrorRule(owner, plan, funding, { basketName: input.basketName, createdTx: input.txHash }, now);
  return getRepos().automation.create(rule);
}

function mirrorOf(plan: OnchainPlan, funding: PlanFunding | undefined, createdTx?: Hash): AutomationOnchain {
  return {
    contract: AUTO_INVEST_ADDRESS as Address,
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
    const [rules, plans] = await Promise.all([repos.automation.list(owner), readOnchainPlansOf(owner).catch(() => null)]);
    if (!plans) return rules;
    const out = [...rules];
    const byPlan = new Map(rules.filter((r) => r.config.onchain).map((r) => [r.config.onchain!.planId, r]));
    for (const plan of plans) {
      const funding = plan.status === "active" ? await readFunding(owner, plan.amountPerRun).catch(() => undefined) : undefined;
      const rule = byPlan.get(plan.planId.toString());
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
}

/**
 * Record that the owner ran a manual plan. Only a run that bought something moves the schedule: a
 * run rejected in the wallet stays due, so nothing is silently skipped.
 */
export async function markRun(owner: Address, id: string, summary: RunSummary = {}): Promise<AutomationRule | null> {
  const rules = await getRepos().automation.list(owner);
  const rule = rules.find((r) => r.id === id);
  if (!rule) return null;
  if (!isPlanRule(rule)) throw new AppError("BAD_REQUEST", "Your target mix is not a plan; there is nothing to run.", 400);
  if (isAutoRule(rule)) throw new AppError("BAD_REQUEST", "Auto plans are run by the contract; the app does not mark them by hand.", 400);
  const now = Date.now();
  const ok = summary.ok !== false && (summary.spentUsd ?? 0) > 0;
  const record: AutomationRunRecord = { at: now, ok, via: "wallet", txHash: summary.txHashes?.[0], spentUsd: summary.spentUsd, legs: summary.legs, error: ok ? undefined : (summary.error ?? "Nothing was bought.") };
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
  const plan = await readOnchainPlan(BigInt(rule.config.onchain.planId));
  if (!plan) return rule;
  const funding = plan.status === "active" ? await readFunding(owner, plan.amountPerRun).catch(() => undefined) : undefined;
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
