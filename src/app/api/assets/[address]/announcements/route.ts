import { route, json, addressParam } from "@/lib/api";
import { getCorporateActions } from "@/services/announcement-service";
import { findCuratedAsset } from "@/lib/b20/registry";
import { AppError } from "@/lib/errors";

/** Corporate-action events for a stock (announcements, multiplier updates). */
export const GET = route<{ params: Promise<{ address: string }> }>({ rateLimit: { key: "announcements", limit: 60, windowMs: 60_000 } }, async (_req, { params }) => {
  const address = await addressParam(params);
  if (!findCuratedAsset(address)) throw new AppError("NOT_FOUND", "Unknown asset", 404);
  const result = await getCorporateActions(address);
  return json({ assetAddress: address, ...result, updatedAt: Date.now() }, { cacheSeconds: 300, staleSeconds: 1800 });
});
