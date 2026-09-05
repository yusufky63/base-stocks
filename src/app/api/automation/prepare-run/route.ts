import { z } from "zod";
import { route, json, parseBody } from "@/lib/api";
import { requireSession } from "@/lib/auth/session";
import { getRepos } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { isAutoInvestDeployed, swapToDto } from "@/lib/auto-invest";
import { readOnchainPlan } from "@/services/auto-invest-chain";
import { buildRunSwaps } from "@/services/auto-invest-keeper";

/** Quotes and the contract's simulation can take a few seconds per leg. */
export const maxDuration = 60;

const bodySchema = z.object({ id: z.string().min(4) });

/**
 * Everything the plan owner needs to run a due auto plan from their own wallet: one swap per leg,
 * built exactly as the keeper would build it. The owner then calls `execute` themselves — useful
 * when no keeper is configured, or when they simply do not want to wait for the next tick.
 */
export const POST = route({ rateLimit: { key: "automation.prepare", limit: 20, windowMs: 60_000 } }, async (req) => {
  const owner = requireSession(req);
  if (!isAutoInvestDeployed()) throw new AppError("BAD_REQUEST", "Auto-invest is not enabled on this deployment.", 400);
  const { id } = await parseBody(req, bodySchema);
  const rule = (await getRepos().automation.list(owner)).find((r) => r.id === id);
  if (!rule?.config.onchain) throw new AppError("NOT_FOUND", "Not an auto plan", 404);
  const plan = await readOnchainPlan(BigInt(rule.config.onchain.planId));
  if (!plan) throw new AppError("NOT_FOUND", "That plan does not exist onchain.", 404);
  if (plan.owner.toLowerCase() !== owner.toLowerCase()) throw new AppError("UNAUTHORIZED", "That plan belongs to another wallet.", 403);
  if (plan.status !== "active") throw new AppError("BAD_REQUEST", "The plan is paused or cancelled.", 400);
  if (plan.nextRunAt * 1000 > Date.now()) throw new AppError("BAD_REQUEST", "The next run is not due yet.", 400);
  const prepared = await buildRunSwaps(plan);
  return json({
    planId: plan.planId.toString(),
    total: prepared.total.toString(),
    legs: prepared.legs.map((l) => ({ index: l.index, assetAddress: l.assetAddress, symbol: l.symbol, amountIn: l.amountIn.toString(), usd: l.usd, provider: l.provider ?? null, expectedOut: l.expectedOut?.toString() ?? null, skipped: l.skipped ?? null })),
    swaps: prepared.swaps.map(swapToDto),
  });
});
