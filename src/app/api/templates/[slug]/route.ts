import { route, json } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { AppError } from "@/lib/errors";

export const GET = route<{ params: Promise<{ slug: string }> }>({ rateLimit: { key: "templates", limit: 120, windowMs: 60_000 } }, async (_req, { params }) => {
  const { slug } = await params;
  const template = await getRepos().templates.getBySlug(slug);
  if (!template) throw new AppError("NOT_FOUND", "Template not found", 404);
  return json({ template }, { cacheSeconds: 60, staleSeconds: 600 });
});
