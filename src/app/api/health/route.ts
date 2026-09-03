import { route, json } from "@/lib/api";
import { metrics } from "@/lib/http";
import { getRepos } from "@/db/repositories";
import { getSupabaseAdmin } from "@/db/supabase";
import { schemaMissing } from "@/db/resilient";
import { serverEnv } from "@/config/env";

const REQUIRED_TABLES = ["portfolio_templates", "portfolio_template_allocations", "portfolio_executions", "portfolio_execution_steps", "gifts", "trade_records", "watchlists", "discovered_assets", "ai_usage"];

/** Observability snapshot (provider latency/error rates, fallback usage, storage readiness). No secrets. */
export const GET = route({}, async (req) => {
  const env = serverEnv();
  const admin = env.ADMIN_API_TOKEN && req.headers.get("x-admin-token") === env.ADMIN_API_TOKEN;
  const sb = getSupabaseAdmin();
  let storage: { backend: string; tablesReady: boolean | null; missing: string[] } = { backend: getRepos().backend, tablesReady: null, missing: [] };
  if (sb) {
    const missing: string[] = [];
    await Promise.all(
      REQUIRED_TABLES.map(async (t) => {
        // A real (non-HEAD) select: PostgREST answers PGRST205 when the table is not in its schema cache.
        const { error } = await sb.from(t).select("*").limit(1);
        if (error && (error.code === "PGRST205" || /schema cache|does not exist/i.test(error.message))) missing.push(t);
      }),
    );
    storage = { backend: "supabase", tablesReady: missing.length === 0, missing };
  }
  return json({
    ok: true,
    deploy: { commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null, region: process.env.VERCEL_REGION ?? null, serverless: !!process.env.VERCEL },
    storage,
    schemaMissingSeen: [...schemaMissing],
    providers: admin || env.NODE_ENV !== "production" ? metrics.snapshot() : undefined,
    time: Date.now(),
  });
});
