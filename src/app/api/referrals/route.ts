import { z } from "zod";
import { route, json, parseBody, hashSchema } from "@/lib/api";
import { requireSession } from "@/lib/auth/session";
import { getRepos } from "@/db/repositories";
import { recordFirstTradeForReferral } from "@/services/community-service";
import type { Hash } from "viem";

/** Referral stats for the signed-in wallet (invited / traded). */
export const GET = route({}, async (req) => {
  const address = requireSession(req);
  const repos = getRepos();
  const [stats, mine] = await Promise.all([repos.referrals.statsFor(address), repos.referrals.get(address)]);
  return json({ stats, referredBy: mine?.referrer ?? null });
});

/** Mark the signed-in wallet's first trade (called by the client after a confirmed trade). */
export const POST = route({ rateLimit: { key: "referrals.write", limit: 20, windowMs: 60_000 } }, async (req) => {
  const address = requireSession(req);
  const { txHash } = await parseBody(req, z.object({ txHash: hashSchema }));
  await recordFirstTradeForReferral(address, txHash as Hash);
  return json({ ok: true });
});
