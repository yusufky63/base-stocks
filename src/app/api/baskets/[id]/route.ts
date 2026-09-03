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

/** Vote (toggle, one per signed-in wallet) or count a clone. */
export const POST = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "baskets.action", limit: 60, windowMs: 60_000 } }, async (req, { params }) => {
  const { id } = await params;
  const { action } = await parseBody(req, actionSchema);
  const repos = getRepos();
  const basket = await repos.baskets.get(id);
  if (!basket) throw new AppError("NOT_FOUND", "Basket not found", 404);
  if (action === "vote") {
    const voter = requireSession(req);
    const result = await repos.baskets.vote(id, voter);
    return json(result);
  }
  await repos.baskets.incrementClones(id);
  return json({ ok: true, clones: basket.clones + 1 });
});
