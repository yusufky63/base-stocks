import { z } from "zod";
import { route, json, parseQuery, addressSchema } from "@/lib/api";
import { getLpPositions } from "@/services/lp-positions-service";

/** Serverless budget: upstream providers and the model may take longer than the 10 s default. */
export const maxDuration = 60;

/** Read-only concentrated-liquidity positions (Aerodrome Slipstream, Uniswap v3) that involve a tokenized stock. */
export const GET = route({ rateLimit: { key: "earn.lp", limit: 60, windowMs: 60_000 } }, async (req) => {
  const { user } = parseQuery(req, z.object({ user: addressSchema }));
  const positions = await getLpPositions(user);
  return json({ positions, readAt: Date.now() });
});
