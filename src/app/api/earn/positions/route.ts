import { z } from "zod";
import { route, json, parseQuery, addressSchema } from "@/lib/api";
import { getEarnPositions } from "@/services/earn-opportunity-service";

export const GET = route({ rateLimit: { key: "earn.positions", limit: 120, windowMs: 60_000 } }, async (req) => {
  const { user } = parseQuery(req, z.object({ user: addressSchema }));
  const positions = await getEarnPositions(user);
  return json({ positions: positions.map((p) => ({ ...p, assets: p.assets.toString() })), updatedAt: Date.now() });
});
