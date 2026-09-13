import { route, json, addressParam } from "@/lib/api";
import { sessionAddress } from "@/lib/auth/session";
import { getPortfolioSnapshot } from "@/services/portfolio-service";

/** Serverless budget: upstream providers and the model may take longer than the 10 s default. */
export const maxDuration = 60;

/** Multiplier-aware portfolio snapshot (scaled balances, market + reference values). */
export const GET = route<{ params: Promise<{ address: string }> }>({ rateLimit: { key: "portfolio", limit: 120, windowMs: 60_000 } }, async (req, { params }) => {
  const owner = await addressParam(params);
  // The session only says whose visit this is (for the daily value history); the snapshot itself is public data.
  const snapshot = await getPortfolioSnapshot(owner, { viewer: sessionAddress(req) });
  return json(snapshot);
});
