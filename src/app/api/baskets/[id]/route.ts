import { z } from "zod";
import { route, json, parseBody } from "@/lib/api";
import { requireSession, sessionAddress } from "@/lib/auth/session";
import { getRepos } from "@/db/repositories";
import { AppError } from "@/lib/errors";

export const GET = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "baskets.read", limit: 120, windowMs: 60_000 } }, async (req, { params }) => {
  const { id } = await params;
  const basket = await getRepos().baskets.get(id);
  if (!basket) throw new AppError("NOT_FOUND", "Basket not found", 404);
  const me = sessionAddress(req);
  const voted = me ? await getRepos().baskets.hasVoted(id, me) : false;
  const owner = await getRepos().profiles.get(basket.owner);
  return json({ basket, voted, ownerProfile: owner });
});

const actionSchema = z.object({ action: z.enum(["vote", "clone"]) });

/**
 * Vote (toggle) or count a clone, each once per signed-in wallet. A clone used to count on any
 * unauthenticated POST, so the number said how many requests had arrived rather than how many
 * wallets had built the basket.
 */
export const POST = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "baskets.action", limit: 60, windowMs: 60_000, durable: true } }, async (req, { params }) => {
  const { id } = await params;
  const { action } = await parseBody(req, actionSchema);
  const repos = getRepos();
  const basket = await repos.baskets.get(id);
  if (!basket) throw new AppError("NOT_FOUND", "Basket not found", 404);
  const wallet = requireSession(req);
  if (action === "vote") {
    const result = await repos.baskets.vote(id, wallet);
    return json(result);
  }
  // The resilient wrapper answers `undefined` when storage is down; the clone still happened in the wallet.
  const result = (await repos.baskets.incrementClones(id, wallet)) as { counted: boolean; clones: number } | undefined;
  return json({ ok: true, counted: result?.counted ?? false, clones: result?.clones ?? basket.clones });
});
