import { z } from "zod";
import { route, json, parseBody, parseQuery, addressSchema } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { isCuratedAsset } from "@/lib/b20/registry";
import { AppError } from "@/lib/errors";
import { requireOwner } from "@/lib/auth/session";

const bodySchema = z.object({ owner: addressSchema, assetAddress: addressSchema });

export const GET = route({ rateLimit: { key: "watchlist", limit: 120, windowMs: 60_000 } }, async (req) => {
  const { owner } = parseQuery(req, z.object({ owner: addressSchema }));
  return json({ assets: await getRepos().watchlists.list(owner) });
});

/** A watchlist is its wallet's own to edit: writes need the signed-in owner. */
export const POST = route({ rateLimit: { key: "watchlist.write", limit: 60, windowMs: 60_000, durable: true } }, async (req) => {
  const { owner, assetAddress } = await parseBody(req, bodySchema);
  requireOwner(req, owner);
  if (!isCuratedAsset(assetAddress)) throw new AppError("ASSET_NOT_CANONICAL", "Unknown asset", 400);
  await getRepos().watchlists.add(owner, assetAddress);
  return json({ ok: true });
});

export const DELETE = route({ rateLimit: { key: "watchlist.write", limit: 60, windowMs: 60_000, durable: true } }, async (req) => {
  const { owner, assetAddress } = await parseBody(req, bodySchema);
  requireOwner(req, owner);
  await getRepos().watchlists.remove(owner, assetAddress);
  return json({ ok: true });
});
