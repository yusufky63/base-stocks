import type { Address } from "viem";
import type { AutomationRule } from "@/domain/community";
import { getRepos } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { newId } from "@/lib/execution/portfolio-execution";
import { validateAllocations } from "./portfolio-service";
import { isCuratedAsset } from "@/lib/b20/registry";

/**
 * Automation V1 (spec §4.8 default mode): the system proposes, the user reviews and approves
 * every run. Rules only store intent; nothing executes without a wallet confirmation.
 * Spend-Permission-based unattended execution is a later phase.
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
}

export async function createRule(owner: Address, input: CreateRuleInput): Promise<AutomationRule> {
  const now = Date.now();
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
      thresholdBps: input.thresholdBps ?? 500,
      templateId: input.templateId,
    },
    status: "active",
    nextRunAt: input.type === "drift-alert" ? undefined : now,
    createdAt: now,
    updatedAt: now,
  };
  return getRepos().automation.create(rule);
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

/** Mark a run as executed by the user and schedule the next one on the original cadence. */
export async function markRun(owner: Address, id: string): Promise<AutomationRule | null> {
  const rules = await getRepos().automation.list(owner);
  const rule = rules.find((r) => r.id === id);
  if (!rule) return null;
  const now = Date.now();
  return getRepos().automation.update(id, owner, {
    lastRunAt: now,
    nextRunAt: nextRunAfter(rule.nextRunAt, rule.config.cadenceDays ?? 7, now),
  });
}

export function isDue(rule: AutomationRule, now = Date.now()): boolean {
  return rule.status === "active" && rule.nextRunAt !== undefined && rule.nextRunAt <= now;
}
