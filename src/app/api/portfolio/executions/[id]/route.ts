import { z } from "zod";
import { route, json, parseBody } from "@/lib/api";
import { requireOwner } from "@/lib/auth/session";
import { getRepos } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { settleSteps } from "../settle";
import { stepSchema } from "../schema";

const patchSchema = z.object({
  status: z.enum(["READY", "QUOTING", "AWAITING_USER", "EXECUTING", "PARTIALLY_FILLED", "COMPLETE", "FAILED"]).optional(),
  steps: z.array(stepSchema).optional(),
});

export const PATCH = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "exec.write", limit: 120, windowMs: 60_000, durable: true } }, async (req, { params }) => {
  const { id } = await params;
  const body = await parseBody(req, patchSchema);
  const existing = await getRepos().executions.get(id);
  if (!existing) throw new AppError("NOT_FOUND", "Execution not found", 404);
  requireOwner(req, existing.owner);
  // A leg newly reported as confirmed is held to its receipt before it is kept: the stock has to
  // have arrived in the owner's wallet in that transaction, and where the receipt shows the USDC
  // that paid for it, that figure replaces the browser's. Anyone could otherwise PATCH a hash
  // they did not send with any amount and have Activity show it as a purchase.
  const updated = await getRepos().executions.update(id, {
    status: body.status,
    steps: body.steps ? await settleSteps(existing.owner, existing.steps, body.steps) : undefined,
    updatedAt: Date.now(),
  });
  if (!updated) throw new AppError("NOT_FOUND", "Execution not found", 404);
  return json({ execution: updated });
});

export const GET = route<{ params: Promise<{ id: string }> }>({}, async (req, { params }) => {
  const { id } = await params;
  const exec = await getRepos().executions.get(id);
  if (!exec) throw new AppError("NOT_FOUND", "Execution not found", 404);
  requireOwner(req, exec.owner);
  return json({ execution: exec });
});
