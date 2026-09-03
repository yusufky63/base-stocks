import { route, json, addressParam } from "@/lib/api";
import { getPortfolioSnapshot } from "@/services/portfolio-service";

/** Multiplier-aware portfolio snapshot (scaled balances, market + reference values). */
export const GET = route<{ params: Promise<{ address: string }> }>({ rateLimit: { key: "portfolio", limit: 120, windowMs: 60_000 } }, async (_req, { params }) => {
  const owner = await addressParam(params);
  const snapshot = await getPortfolioSnapshot(owner);
  return json(snapshot);
});
