import { route, json, addressParam } from "@/lib/api";
import { getActivity } from "@/services/activity-service";

/** Serverless budget: upstream providers and the model may take longer than the 10 s default. */
export const maxDuration = 60;

export const GET = route<{ params: Promise<{ address: string }> }>({ rateLimit: { key: "activity", limit: 60, windowMs: 60_000 } }, async (_req, { params }) => {
  const owner = await addressParam(params);
  const items = await getActivity(owner);
  return json({ items, readAt: Date.now() });
});
