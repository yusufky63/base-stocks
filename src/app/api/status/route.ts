import { route, json } from "@/lib/api";
import { getStatusReport } from "@/services/status-service";

/** Public status of every upstream (active probes, cached 30 s). No secrets, no user data. */
export const GET = route({ rateLimit: { key: "status", limit: 30, windowMs: 60_000 } }, async () => {
  const report = await getStatusReport();
  return json(report, { cacheSeconds: 15 });
});
