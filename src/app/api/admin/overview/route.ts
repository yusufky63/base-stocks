import { route, json, requireAdmin } from "@/lib/api";
import { serverEnv, publicEnv } from "@/config/env";
import { getSupabaseAdmin } from "@/db/supabase";
import { getRepos } from "@/db/repositories";
import { indexStatus } from "@/services/chain-index-service";
import { monthlyBudgetUsd, monthlySpendUsd, quotaLimitsFromEnv } from "@/lib/ai-quota";

export const maxDuration = 30;

/** Counted for the console because each one grows without an obvious ceiling. */
const COUNTED_TABLES = ["trade_records", "chain_transfers", "wallet_index", "portfolio_executions", "gifts", "discovered_assets", "error_events", "ai_usage", "kv_cache"] as const;

/** Rows whose only purpose is a daily counter; the AI spend guard reads this one. */
const AI_GLOBAL_KEY = "global";

async function countRows(): Promise<Record<string, number | null>> {
  const sb = getSupabaseAdmin();
  const out: Record<string, number | null> = {};
  if (!sb) return out;
  await Promise.all(
    COUNTED_TABLES.map(async (t) => {
      const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
      out[t] = error ? null : (count ?? 0);
    }),
  );
  return out;
}

async function aiUsage(): Promise<{ today: number; limits: ReturnType<typeof quotaLimitsFromEnv>; spendUsd: number; budgetUsd: number }> {
  const sb = getSupabaseAdmin();
  const day = new Date().toISOString().slice(0, 10);
  let today = 0;
  if (sb) {
    const { data } = await sb.from("ai_usage").select("count").eq("key", AI_GLOBAL_KEY).eq("day", day).maybeSingle();
    today = typeof (data as { count?: number } | null)?.count === "number" ? (data as { count: number }).count : 0;
  }
  return { today, limits: quotaLimitsFromEnv(), spendUsd: await monthlySpendUsd().catch(() => 0), budgetUsd: monthlyBudgetUsd() };
}

/**
 * Admin: the operational facts that are not alerts.
 *
 * `/api/health` answers "is anything wrong right now"; this answers "what is this deployment
 * actually doing" — how far behind the transfer index is, how much of the day's AI budget is
 * gone, how many rows the growing tables hold, and which optional capabilities this deployment
 * has keys for. Capabilities are booleans derived from the environment: whether a key is set,
 * never what it is.
 */
export const GET = route({ rateLimit: { key: "admin.overview", limit: 60, windowMs: 60_000 } }, async (req) => {
  const env = serverEnv();
  requireAdmin(req, env.ADMIN_API_TOKEN);

  const [index, ai, tables, rules] = await Promise.all([
    indexStatus().catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
    aiUsage().catch(() => null),
    countRows().catch(() => ({})),
    getRepos()
      .automation.listAuto()
      .catch(() => []),
  ]);

  return json({
    index,
    ai,
    tables,
    automation: {
      autoRules: rules.length,
      onchainPlans: rules.filter((r) => r.config.onchain).length,
      maxRunsPerTick: env.AUTOMATION_MAX_RUNS_PER_TICK,
      keeperConfigured: !!env.AUTOMATION_KEEPER_KEY,
      contract: publicEnv.autoInvestAddress || null,
    },
    /** Optional capabilities, as booleans. A `false` here is a feature this deployment is running without. */
    capabilities: {
      storage: !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY,
      persistentSessions: !!env.AUTH_SECRET,
      cronSecret: !!env.CRON_SECRET,
      dedicatedRpc: !!env.BASE_RPC_URL,
      backupRpc: !!env.DRPC_RPC_URL,
      ai: !!env.ANTHROPIC_API_KEY || !!env.AI_API_KEY,
      zeroX: !!env.ZEROX_API_KEY,
      uniswap: !!env.UNISWAP_API_KEY,
      kyberKey: !!env.KYBER_API_KEY,
      okx: !!env.OKX_API_KEY && !!env.OKX_SECRET_KEY && !!env.OKX_PASSPHRASE,
      coingecko: !!env.COINGECKO_API_KEY,
      integratorFee: !!env.INTEGRATOR_FEE_RECIPIENT && !!env.INTEGRATOR_FEE_BPS,
      giftPools: !!publicEnv.giftPoolAddress,
      questGating: !!env.POOL_GATE_SIGNER_KEY,
      autoInvest: !!publicEnv.autoInvestAddress,
      paymaster: !!publicEnv.paymasterUrl,
      geoblock: !!env.GEOBLOCK_COUNTRIES,
    },
    settings: {
      geoblockMode: env.GEOBLOCK_MODE ?? "attest",
      geoblockCountries: env.GEOBLOCK_COUNTRIES ?? "",
      integratorFeeBps: env.INTEGRATOR_FEE_BPS ?? 0,
      oracleStalenessSeconds: env.ORACLE_STALENESS_SECONDS,
      backend: getRepos().backend,
      nodeEnv: env.NODE_ENV,
    },
    time: Date.now(),
  });
});
