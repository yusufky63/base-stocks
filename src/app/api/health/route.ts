import { formatEther } from "viem";
import { route, json, secretEquals } from "@/lib/api";
import { metrics } from "@/lib/http";
import { getRepos } from "@/db/repositories";
import { getSupabaseAdmin } from "@/db/supabase";
import { schemaMissing } from "@/db/resilient";
import { serverEnv } from "@/config/env";
import { cached, peekShared } from "@/lib/cache";
import { errorCountBySource, recentErrors } from "@/lib/error-sink";
import { keeperAddress } from "@/lib/viem/keeper-client";
import { getServerPublicClient } from "@/lib/viem/server-client";
import type { StatusReport } from "@/services/status-service";

const REQUIRED_TABLES = ["portfolio_templates", "portfolio_template_allocations", "portfolio_executions", "portfolio_execution_steps", "gifts", "trade_records", "watchlists", "discovered_assets", "ai_usage", "tx_receipts", "kv_cache", "chain_transfers", "wallet_index", "error_events"];

/** The keeper needs this much ETH to keep running plans; below it, someone has to top it up. */
const KEEPER_MIN_ETH = 0.0005;
/** Distinct server-side errors in the last hour that count as "something is wrong". */
const SERVER_ERRORS_PER_HOUR_ALERT = 20;
/**
 * Client errors get their own, higher bar: browsers report through a public route, so any visitor
 * can produce twenty distinct messages in a minute, and one bad extension on one laptop is not an
 * incident. Sixty distinct ones in an hour usually is.
 */
const CLIENT_ERRORS_PER_HOUR_ALERT = 60;

interface StorageProbe {
  backend: string;
  tablesReady: boolean | null;
  missing: string[];
}

/**
 * Fourteen real selects against Supabase, once a minute at most. The monitor asks every half hour,
 * but the route is public and a refresh-happy tab or a scanner would otherwise turn it into a
 * load generator against the database.
 */
function probeStorage(): Promise<StorageProbe> {
  return cached("health:storage", { ttlMs: 60_000 }, async () => {
    const sb = getSupabaseAdmin();
    if (!sb) return { backend: getRepos().backend, tablesReady: null, missing: [] };
    const missing: string[] = [];
    await Promise.all(
      REQUIRED_TABLES.map(async (t) => {
        // A real (non-HEAD) select: PostgREST answers PGRST205 when the table is not in its schema cache.
        const { error } = await sb.from(t).select("*").limit(1);
        if (error && (error.code === "PGRST205" || /schema cache|does not exist/i.test(error.message))) missing.push(t);
      }),
    );
    return { backend: "supabase", tablesReady: missing.length === 0, missing };
  });
}

/** The keeper's balance, cached a minute for the same reason as the tables. */
function probeKeeper(): Promise<{ address: `0x${string}`; eth: string | null } | null> {
  return cached("health:keeper", { ttlMs: 60_000 }, async () => {
    const keeper = keeperAddress();
    if (!keeper) return null;
    try {
      const wei = await getServerPublicClient().getBalance({ address: keeper });
      return { address: keeper, eth: formatEther(wei) };
    } catch {
      // A balance read failing is not itself an alert.
      return { address: keeper, eth: null };
    }
  });
}

/**
 * Observability snapshot: storage readiness, deploy, and — for the monitor workflow — a list of
 * `alerts` that is empty when all is well. What is public is what the monitor needs: `ok`, the
 * alert count and the deploy commit. The rest (which table is missing, the keeper's address and
 * balance, whether AUTH_SECRET is set, the provider counters, the recent errors) is an inventory
 * of the deployment and is shown only with the admin token, or outside production.
 */
export const GET = route({ rateLimit: { key: "health", limit: 30, windowMs: 60_000 } }, async (req) => {
  const env = serverEnv();
  const admin = !!env.ADMIN_API_TOKEN && secretEquals(req.headers.get("x-admin-token"), env.ADMIN_API_TOKEN);
  const verbose = admin || env.NODE_ENV !== "production";

  const [storage, keeper, status, errors] = await Promise.all([
    probeStorage(),
    probeKeeper(),
    // The status report lives in the shared tier: the instance answering here is rarely the one that probed.
    peekShared<StatusReport>("status:report"),
    errorCountBySource(3600_000).catch(() => ({ server: 0, client: 0 })),
  ]);

  const alerts: string[] = [];
  if (keeper?.eth !== null && keeper?.eth !== undefined && Number(keeper.eth) < KEEPER_MIN_ETH) alerts.push(`keeper holds ${Number(keeper.eth).toFixed(5)} ETH (< ${KEEPER_MIN_ETH})`);
  if (status?.overall === "down") alerts.push(`status: ${status.checks.filter((c) => c.status === "down" && c.group !== "News").map((c) => c.name).join(", ") || "outage"}`);
  if (errors.server >= SERVER_ERRORS_PER_HOUR_ALERT) alerts.push(`${errors.server} distinct server errors in the last hour`);
  if (errors.client >= CLIENT_ERRORS_PER_HOUR_ALERT) alerts.push(`${errors.client} distinct client errors in the last hour`);
  if (storage.tablesReady === false) alerts.push(`storage missing: ${storage.missing.join(", ")}`);

  return json({
    ok: true,
    deploy: { commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null, region: process.env.VERCEL_REGION ?? null, serverless: !!process.env.VERCEL },
    storage: verbose ? storage : { backend: storage.backend, tablesReady: storage.tablesReady },
    /** Without AUTH_SECRET every instance signs sessions with its own random key: sign-ins do not survive restarts or other instances. */
    auth: verbose ? { persistentSessions: !!env.AUTH_SECRET } : undefined,
    schemaMissingSeen: verbose ? [...schemaMissing] : undefined,
    keeper: verbose ? keeper : undefined,
    errors: { lastHour: errors.server + errors.client, server: errors.server, client: errors.client },
    alertCount: alerts.length,
    // The monitor reads the texts; a stranger gets the count. The texts name tables and balances.
    alerts: verbose ? alerts : alerts.map(() => "see /admin"),
    providers: verbose ? metrics.snapshot() : undefined,
    recentErrors: verbose ? await recentErrors(20).catch(() => []) : undefined,
    time: Date.now(),
  });
});
