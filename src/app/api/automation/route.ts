import { z } from "zod";
import { route, json, parseBody, addressSchema, hashSchema } from "@/lib/api";
import { requireSession } from "@/lib/auth/session";
import { getRepos } from "@/db/repositories";
import { createRule, invalidateRules, isDue, isAutoRule, isPlanRule, listRulesSynced, markRun, missedRuns, setThreshold, syncRule } from "@/services/automation-service";
import { isKeeperConfigured, keeperAddress } from "@/lib/viem/keeper-client";
import { readOnchainPlan } from "@/services/auto-invest-chain";
import { outcomeFromReceipt, recordRun } from "@/services/auto-invest-keeper";
import { isAutoInvestDeployed, AUTO_INVEST_ADDRESS } from "@/lib/auto-invest";
import { AppError } from "@/lib/errors";
import type { Hash } from "viem";

/** Chain reads for auto plans can take a moment on a cold instance. */
export const maxDuration = 30;

const allocationSchema = z.object({ assetAddress: z.union([z.literal("USDC"), addressSchema]), weightBps: z.number().int().min(1).max(10_000) });

const createSchema = z.object({
  type: z.enum(["recurring-buy", "recurring-basket", "drift-alert"]),
  assetAddress: addressSchema.optional(),
  basketName: z.string().max(48).optional(),
  allocations: z.array(allocationSchema).max(20).optional(),
  amountUsd: z.number().min(1).max(1_000).optional(),
  cadenceDays: z.number().int().min(1).max(90).optional(),
  thresholdBps: z.number().int().min(100).max(5000).optional(),
  templateId: z.string().max(64).optional(),
  mode: z.enum(["manual", "auto"]).optional(),
  onchainPlanId: z.string().regex(/^\d+$/).optional(),
  txHash: hashSchema.optional(),
});

function decorate<T extends { nextRunAt?: number; type: string; status: string }>(r: T & Parameters<typeof isDue>[0]) {
  return { ...r, due: isDue(r), missed: missedRuns(r) };
}

/** Rules for the signed-in wallet: manual plans, auto plans refreshed from the chain, and the target mix. */
export const GET = route({}, async (req) => {
  const owner = requireSession(req);
  const rules = await listRulesSynced(owner);
  return json({
    rules: rules.map(decorate),
    autoInvest: { enabled: isAutoInvestDeployed(), address: isAutoInvestDeployed() ? AUTO_INVEST_ADDRESS : null, keeperConfigured: isKeeperConfigured(), keeper: keeperAddress() },
  });
});

export const POST = route({ rateLimit: { key: "automation.write", limit: 20, windowMs: 60_000, durable: true } }, async (req) => {
  const owner = requireSession(req);
  const body = await parseBody(req, createSchema);
  const rule = await createRule(owner, { ...body, txHash: body.txHash as Hash | undefined });
  invalidateRules(owner);
  return json({ rule: decorate(rule) }, { status: 201 });
});

const runLegSchema = z.object({ assetAddress: addressSchema, symbol: z.string().max(16).optional(), spentUsd: z.number().min(0), received: z.string().regex(/^\d+$/).optional(), provider: z.string().max(32).optional(), skipped: z.string().max(200).optional() });

const patchSchema = z.object({
  id: z.string().min(4),
  action: z.enum(["ran", "ran-onchain", "pause", "resume", "delete", "threshold", "sync", "terms"]),
  thresholdBps: z.number().int().min(100).max(5000).optional(),
  /** `terms` (manual plans): new amount and cadence. Auto plans change terms onchain and are synced. */
  amountUsd: z.number().min(1).max(1_000).optional(),
  cadenceDays: z.number().int().min(1).max(90).optional(),
  /** `ran-onchain`: the `execute` transaction the owner sent from their wallet, and why legs were left out. */
  txHash: hashSchema.optional(),
  skipped: z.array(z.object({ assetAddress: addressSchema, reason: z.string().max(200) })).max(20).optional(),
  /** `ran`: what the wallet-confirmed run actually did. */
  summary: z
    .object({
      ok: z.boolean().optional(),
      txHashes: z.array(hashSchema).max(20).optional(),
      spentUsd: z.number().min(0).optional(),
      legs: z.array(runLegSchema).max(20).optional(),
      error: z.string().max(300).optional(),
    })
    .optional(),
});

export const PATCH = route({ rateLimit: { key: "automation.write", limit: 60, windowMs: 60_000, durable: true } }, async (req) => {
  const owner = requireSession(req);
  const { id, action, thresholdBps, summary, txHash, skipped, amountUsd, cadenceDays } = await parseBody(req, patchSchema);
  const repos = getRepos();
  const rule = (await repos.automation.list(owner)).find((r) => r.id === id);
  if (!rule) throw new AppError("NOT_FOUND", "Rule not found", 404);

  if (action === "terms") {
    if (!isPlanRule(rule)) throw new AppError("BAD_REQUEST", "The target mix has no amount or cadence.", 400);
    if (isAutoRule(rule)) throw new AppError("BAD_REQUEST", "Change an auto plan's terms from your wallet; the app mirrors the chain.", 400);
    if (amountUsd === undefined && cadenceDays === undefined) throw new AppError("BAD_REQUEST", "Nothing to change.", 400);
    const updated = await repos.automation.update(id, owner, { config: { ...rule.config, amountUsd: amountUsd ?? rule.config.amountUsd, cadenceDays: cadenceDays ?? rule.config.cadenceDays } });
    invalidateRules(owner);
    return json({ rule: updated ? decorate(updated) : null });
  }

  if (action === "ran-onchain") {
    if (!rule.config.onchain) throw new AppError("BAD_REQUEST", "Not an auto plan", 400);
    if (!txHash) throw new AppError("BAD_REQUEST", "txHash is required", 400);
    if (rule.config.history?.some((h) => h.txHash?.toLowerCase() === txHash.toLowerCase())) return json({ rule: decorate(rule) });
    const plan = await readOnchainPlan(BigInt(rule.config.onchain.planId));
    if (!plan) throw new AppError("NOT_FOUND", "That plan does not exist onchain.", 404);
    const outcome = await outcomeFromReceipt(plan, txHash as Hash, new Map((skipped ?? []).map((s) => [s.assetAddress.toLowerCase(), s.reason])));
    await recordRun(rule, plan, outcome, "wallet");
    const updated = (await repos.automation.list(owner)).find((r) => r.id === id);
    return json({ rule: updated ? decorate(updated) : null });
  }

  if (action === "delete") {
    // An auto plan that is still live onchain would just be re-mirrored on the next read; it has to
    // be cancelled in the contract first, which only the owner's wallet can do.
    if (isAutoRule(rule) && rule.config.onchain?.status !== "cancelled") {
      const synced = await syncRule(owner, id);
      if (synced?.config.onchain?.status !== "cancelled") throw new AppError("BAD_REQUEST", "Cancel the plan onchain first; then it can be removed here.", 409);
    }
    await repos.automation.remove(id, owner);
    invalidateRules(owner);
    return json({ ok: true });
  }
  if (action === "sync") {
    const synced = await syncRule(owner, id);
    return json({ rule: synced ? decorate(synced) : null });
  }
  if (action === "threshold") {
    if (thresholdBps === undefined) throw new AppError("BAD_REQUEST", "thresholdBps is required", 400);
    const updated = await setThreshold(owner, id, thresholdBps);
    invalidateRules(owner);
    return json({ rule: updated ? decorate(updated) : null });
  }
  if (action === "ran") {
    const updated = await markRun(owner, id, { ...summary, txHashes: summary?.txHashes as Hash[] | undefined });
    invalidateRules(owner);
    return json({ rule: updated ? decorate(updated) : null });
  }
  // pause / resume: manual plans (and the target) live here; auto plans change state onchain and are only synced.
  if (isAutoRule(rule)) throw new AppError("BAD_REQUEST", "Pause or resume an auto plan from your wallet; the app mirrors the chain.", 400);
  if (!isPlanRule(rule) && action === "pause") throw new AppError("BAD_REQUEST", "The target mix has no schedule to pause; clear it from Portfolio → Rebalance instead.", 400);
  const updated = await repos.automation.update(id, owner, { status: action === "pause" ? "paused" : "active" });
  if (!updated) throw new AppError("NOT_FOUND", "Rule not found", 404);
  invalidateRules(owner);
  return json({ rule: decorate(updated) });
});
