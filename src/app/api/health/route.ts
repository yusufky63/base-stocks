import { formatEther } from "viem";
import { route, json } from "@/lib/api";
import { metrics } from "@/lib/http";
import { getRepos } from "@/db/repositories";
import { getSupabaseAdmin } from "@/db/supabase";
import { schemaMissing } from "@/db/resilient";
import { serverEnv } from "@/config/env";
import { peek } from "@/lib/cache";
import { errorCount, recentErrors } from "@/lib/error-sink";
import { keeperAddress } from "@/lib/viem/keeper-client";
import { getServerPublicClient } from "@/lib/viem/server-client";
import type { StatusReport } from "@/services/status-service";

const REQUIRED_TABLES = ["portfolio_templates", "portfolio_template_allocations", "portfolio_executions", "portfolio_execution_steps", "gifts", "trade_records", "watchlists", "discovered_assets", "ai_usage", "tx_receipts", "kv_cache", "chain_transfers", "wallet_index", "error_events"];

/** The keeper needs this much ETH to keep running plans; below it, someone has to top it up. */
const KEEPER_MIN_ETH = 0.0005;
/** Error occurrences in the last hour that count as "something is wrong". */
/** Distinct errors, not occurrences: twenty different failures in an hour is the alarm. */
const ERRORS_PER_HOUR_ALERT = 20;

/**
 * Observability snapshot: storage readiness, deploy, and — for the monitor workflow — a list of
 * `alerts` that is empty when all is well. Provider counters and recent errors are shown in
 * non-production or with the admin token. No secrets, no user data.
 */
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

  const alerts: string[] = [];
  const keeper = keeperAddress();
  let keeperEth: string | null = null;
  if (keeper) {
    try {
      const wei = await getServerPublicClient().getBalance({ address: keeper });
      keeperEth = formatEther(wei);
      if (Number(keeperEth) < KEEPER_MIN_ETH) alerts.push(`keeper ${keeper.slice(0, 8)}… holds ${Number(keeperEth).toFixed(5)} ETH (< ${KEEPER_MIN_ETH})`);
    } catch {
      /* a balance read failing is not itself an alert */
    }
  }
  const status = peek<StatusReport>("status:report");
  if (status?.overall === "down") alerts.push(`status: ${status.checks.filter((c) => c.status === "down" && c.group !== "News").map((c) => c.name).join(", ") || "outage"}`);
  const errorsLastHour = await errorCount(3600_000).catch(() => 0);
  if (errorsLastHour >= ERRORS_PER_HOUR_ALERT) alerts.push(`${errorsLastHour} distinct errors in the last hour`);
  if (storage.tablesReady === false) alerts.push(`storage missing: ${storage.missing.join(", ")}`);

  return json({
    ok: true,
    deploy: { commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null, region: process.env.VERCEL_REGION ?? null, serverless: !!process.env.VERCEL },
    storage,
    /** Without AUTH_SECRET every instance signs sessions with its own random key: sign-ins do not survive restarts or other instances. */
    auth: { persistentSessions: !!env.AUTH_SECRET },
    schemaMissingSeen: [...schemaMissing],
    keeper: keeper ? { address: keeper, eth: keeperEth } : null,
    errors: { lastHour: errorsLastHour },
    alerts,
    providers: admin || env.NODE_ENV !== "production" ? metrics.snapshot() : undefined,
    recentErrors: admin || env.NODE_ENV !== "production" ? await recentErrors(20).catch(() => []) : undefined,
    time: Date.now(),
  });
});
