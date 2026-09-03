import { route, json, addressParam } from "@/lib/api";
import { getTokenMarket, marketDataConfigured } from "@/services/market-service";

export const GET = route<{ params: Promise<{ address: string }> }>({ rateLimit: { key: "market", limit: 240, windowMs: 60_000 } }, async (_req, { params }) => {
  const address = await addressParam(params);
  const market = await getTokenMarket(address);
  return json({ market, enabled: marketDataConfigured() }, { cacheSeconds: 20, staleSeconds: 120 });
});
