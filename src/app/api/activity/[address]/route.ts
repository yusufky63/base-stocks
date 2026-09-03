import { route, json, addressParam } from "@/lib/api";
import { getActivity } from "@/services/activity-service";

export const GET = route<{ params: Promise<{ address: string }> }>({ rateLimit: { key: "activity", limit: 60, windowMs: 60_000 } }, async (_req, { params }) => {
  const owner = await addressParam(params);
  const items = await getActivity(owner);
  return json({ items, readAt: Date.now() });
});
