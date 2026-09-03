import { route, json } from "@/lib/api";
import { getRepos } from "@/db/repositories";

/** Portfolio templates (content layer). Templates are not investment recommendations. */
export const GET = route({ rateLimit: { key: "templates", limit: 120, windowMs: 60_000 } }, async () => {
  const templates = await getRepos().templates.list(true);
  return json({ templates }, { cacheSeconds: 60, staleSeconds: 600 });
});
