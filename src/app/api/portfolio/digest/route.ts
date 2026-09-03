import { route, json } from "@/lib/api";
import { requireSession } from "@/lib/auth/session";
import { clientIp } from "@/lib/ai-quota";
import { digestsEnabled, generatePortfolioDigest, getStoredPortfolioDigest } from "@/services/digest-service";

/** Serverless budget: upstream providers and the model may take longer than the 10 s default. */
export const maxDuration = 60;

/** Today's stored brief for the signed-in wallet (never triggers a model call). */
export const GET = route({}, async (req) => {
  const owner = requireSession(req);
  if (!digestsEnabled()) return json({ enabled: false, digest: null });
  return json({ enabled: true, digest: await getStoredPortfolioDigest(owner) });
});

/**
 * Generate the signed-in wallet's brief for today, or return the one already generated. One model
 * call per wallet per UTC day at most; counted against the AI quota and monthly budget.
 */
export const POST = route({ rateLimit: { key: "portfolio.digest", limit: 6, windowMs: 60_000 } }, async (req) => {
  const owner = requireSession(req);
  const result = await generatePortfolioDigest(owner, clientIp(req));
  if (!result.digest) return json({ ok: false, errors: [result.error ?? "No summary available."], quota: result.quota }, { status: 429 });
  return json({ ok: true, digest: result.digest, quota: result.quota, charged: result.charged });
});
