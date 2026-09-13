import { z } from "zod";
import { route, json, parseBody, parseQuery, addressSchema } from "@/lib/api";
import { requireOwner } from "@/lib/auth/session";
import { getRepos } from "@/db/repositories";
import type { PortfolioExecution } from "@/domain/portfolio";
import { settleSteps } from "./settle";
import { stepSchema } from "./schema";

const createSchema = z.object({
  id: z.string().min(8).max(64),
  owner: addressSchema,
  totalUsd: z.number().positive(),
  steps: z.array(stepSchema).min(1).max(20),
});

/**
 * Persist a multi-leg execution so partial fills are never lost (spec §25). Only the signed-in
 * owner can write their own record: a wallet's execution history is theirs alone to add to.
 */
export const POST = route({ rateLimit: { key: "exec.write", limit: 30, windowMs: 60_000, durable: true } }, async (req) => {
  const body = await parseBody(req, createSchema);
  requireOwner(req, body.owner);
  const now = Date.now();
  const exec: PortfolioExecution = {
    id: body.id,
    owner: body.owner,
    status: "READY",
    totalUsd: body.totalUsd,
    // A record is normally created before anything is sent; a leg already filed as confirmed is checked like a patch.
    steps: await settleSteps(body.owner, [], body.steps),
    createdAt: now,
    updatedAt: now,
  };
  await getRepos().executions.create(exec);
  return json({ execution: exec }, { status: 201 });
});

export const GET = route({ rateLimit: { key: "exec.read", limit: 120, windowMs: 60_000 } }, async (req) => {
  const { owner } = parseQuery(req, z.object({ owner: addressSchema }));
  requireOwner(req, owner);
  return json({ executions: await getRepos().executions.listByOwner(owner) });
});

