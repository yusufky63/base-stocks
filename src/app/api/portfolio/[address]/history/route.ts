import { z } from "zod";
import { route, json, addressParam, parseQuery } from "@/lib/api";
import { getRepos } from "@/db/repositories";

/** Daily portfolio value snapshots (recorded whenever the portfolio is loaded, once per day). */
export const GET = route<{ params: Promise<{ address: string }> }>({ rateLimit: { key: "portfolio.history", limit: 120, windowMs: 60_000 } }, async (req, { params }) => {
  const address = await addressParam(params);
  const { days } = parseQuery(req, z.object({ days: z.coerce.number().int().min(7).max(365).default(90) }));
  const rows = await getRepos().snapshots.list(address, days);
  return json({ points: rows.map((r) => ({ day: r.day, totalUsd: r.totalUsd })) });
});
