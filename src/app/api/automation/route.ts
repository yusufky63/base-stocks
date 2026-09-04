import { z } from "zod";
import { route, json, parseBody, addressSchema } from "@/lib/api";
import { requireSession } from "@/lib/auth/session";
import { getRepos } from "@/db/repositories";
import { createRule, isDue, markRun, missedRuns } from "@/services/automation-service";
import { AppError } from "@/lib/errors";

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
});

/** Rules for the signed-in wallet, with a computed `due` flag. */
export const GET = route({}, async (req) => {
  const owner = requireSession(req);
  const rules = await getRepos().automation.list(owner);
  return json({ rules: rules.map((r) => ({ ...r, due: isDue(r), missed: missedRuns(r) })) });
});

export const POST = route({ rateLimit: { key: "automation.write", limit: 20, windowMs: 60_000, durable: true } }, async (req) => {
  const owner = requireSession(req);
  const body = await parseBody(req, createSchema);
  const rule = await createRule(owner, body);
  return json({ rule }, { status: 201 });
});

const patchSchema = z.object({ id: z.string().min(4), action: z.enum(["ran", "pause", "resume", "delete"]) });

export const PATCH = route({ rateLimit: { key: "automation.write", limit: 60, windowMs: 60_000, durable: true } }, async (req) => {
  const owner = requireSession(req);
  const { id, action } = await parseBody(req, patchSchema);
  const repos = getRepos();
  if (action === "delete") {
    await repos.automation.remove(id, owner);
    return json({ ok: true });
  }
  const updated = action === "ran" ? await markRun(owner, id) : await repos.automation.update(id, owner, { status: action === "pause" ? "paused" : "active" });
  if (!updated) throw new AppError("NOT_FOUND", "Rule not found", 404);
  return json({ rule: { ...updated, due: isDue(updated), missed: missedRuns(updated) } });
});
