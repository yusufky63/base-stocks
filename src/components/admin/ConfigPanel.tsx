"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge, Module, ModuleHeader } from "@/components/ui/primitives";
import { adminFetch, type OverviewResponse } from "./client";

/**
 * What each capability means when it is missing. A `false` below is not a bug — it is a feature
 * this deployment is running without, and the sentence says what a visitor loses because of it.
 */
const CAPABILITIES: Array<{ key: string; label: string; env: string; missing: string }> = [
  { key: "storage", label: "Storage", env: "SUPABASE_URL + SERVICE_ROLE_KEY", missing: "Everything is in-memory and dies with the instance." },
  { key: "persistentSessions", label: "Sessions", env: "AUTH_SECRET", missing: "Each instance signs with its own key; sign-ins do not survive a restart." },
  { key: "cronSecret", label: "Scheduler", env: "CRON_SECRET", missing: "Nothing can call the maintenance jobs on a schedule." },
  { key: "dedicatedRpc", label: "Primary RPC", env: "BASE_RPC_URL", missing: "Chain reads fall back to public endpoints and their rate limits." },
  { key: "backupRpc", label: "Backup RPC", env: "DRPC_RPC_URL", missing: "One RPC outage is felt everywhere." },
  { key: "ai", label: "AI helper", env: "ANTHROPIC_API_KEY / AI_API_KEY", missing: "The assistant and news digests are off." },
  { key: "zeroX", label: "0x", env: "ZEROX_API_KEY", missing: "One trade route fewer; the others still quote." },
  { key: "uniswap", label: "Uniswap", env: "UNISWAP_API_KEY", missing: "The Uniswap route behind KyberSwap is unavailable." },
  { key: "kyberKey", label: "KyberSwap key", env: "KYBER_API_KEY", missing: "Kyber is used unkeyed, on shared limits." },
  { key: "okx", label: "OKX", env: "OKX_API_KEY + SECRET + PASSPHRASE", missing: "The OKX route is unavailable." },
  { key: "coingecko", label: "CoinGecko", env: "COINGECKO_API_KEY", missing: "Price fallbacks use the free tier's limits." },
  { key: "integratorFee", label: "Integrator fee", env: "INTEGRATOR_FEE_BPS + RECIPIENT", missing: "Routes that can carry a fee carry none." },
  { key: "giftPools", label: "Gift pools", env: "NEXT_PUBLIC_GIFT_POOL_ADDRESS", missing: "Pools are hidden from the app." },
  { key: "questGating", label: "Quest gating", env: "POOL_GATE_SIGNER_KEY", missing: "Pools can be open or link-gated only." },
  { key: "autoInvest", label: "AutoInvest", env: "NEXT_PUBLIC_AUTO_INVEST_ADDRESS", missing: "Plans are confirmed by hand; nothing runs on a schedule." },
  { key: "paymaster", label: "Paymaster", env: "NEXT_PUBLIC_PAYMASTER_URL", missing: "Users pay their own gas." },
  { key: "geoblock", label: "Geoblock", env: "GEOBLOCK_COUNTRIES", missing: "No country is refused on execution routes." },
];

/**
 * Configuration, as capabilities rather than variable names.
 *
 * The question this answers is the one asked after every deploy and every env change: what is
 * this deployment able to do right now. Only booleans cross the wire — whether a key is set,
 * never what it is — so the page is safe to read over someone's shoulder.
 */
export function ConfigPanel({ token }: { token: string }) {
  const overview = useQuery({ queryKey: ["admin", "overview", token], queryFn: () => adminFetch<OverviewResponse>(token, "/api/admin/overview") });
  const d = overview.data;
  const on = d ? CAPABILITIES.filter((c) => d.capabilities[c.key]).length : 0;

  return (
    <div className="flex flex-col gap-6">
      <Module>
        <ModuleHeader title="Capabilities" action={d ? <Badge tone={on === CAPABILITIES.length ? "positive" : "neutral"}>{`${on}/${CAPABILITIES.length} configured`}</Badge> : undefined} />
        {overview.error && <p className="px-4 py-3 text-[13px] text-danger-fg">{(overview.error as Error).message}</p>}
        <ul className="divide-y divide-line">
          {CAPABILITIES.map((c) => {
            const enabled = d?.capabilities[c.key] ?? false;
            return (
              <li key={c.key} className="px-4 py-2.5 flex items-start gap-3">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${enabled ? "bg-positive" : "bg-line-strong"}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-[13px] font-medium text-ink">{c.label}</span>
                    <span className="font-mono text-[11px] text-ink-muted">{c.env}</span>
                  </div>
                  {!enabled && <p className="text-[12px] text-ink-secondary mt-0.5">{c.missing}</p>}
                </div>
                <Badge tone={enabled ? "positive" : "neutral"}>{enabled ? "on" : "off"}</Badge>
              </li>
            );
          })}
        </ul>
      </Module>

      <Module>
        <ModuleHeader title="Settings" />
        <dl className="px-4 py-3 grid grid-cols-2 md:grid-cols-3 gap-y-2 gap-x-4 text-[12px] font-mono">
          <Fact k="backend" v={d?.settings.backend ?? "—"} />
          <Fact k="node env" v={d?.settings.nodeEnv ?? "—"} />
          <Fact k="geoblock mode" v={d?.settings.geoblockMode ?? "—"} />
          <Fact k="geoblock list" v={d?.settings.geoblockCountries || "none"} />
          <Fact k="integrator fee" v={d ? `${d.settings.integratorFeeBps} bps` : "—"} />
          <Fact k="oracle staleness" v={d ? `${Math.round(d.settings.oracleStalenessSeconds / 3600)} h` : "—"} />
          <Fact k="automation contract" v={d?.automation.contract ?? "not deployed"} />
          <Fact k="keeper key" v={d?.automation.keeperConfigured ? "set" : "unset"} />
          <Fact k="max runs / tick" v={d ? String(d.automation.maxRunsPerTick) : "—"} />
        </dl>
      </Module>

      <Module>
        <ModuleHeader title="AI budget" />
        {d?.ai ? (
          <div className="px-4 py-3 text-[13px] flex flex-col gap-1.5">
            <div className="text-ink">
              <span className="num">{d.ai.today}</span> of <span className="num">{d.ai.limits.globalPerDay}</span> calls today
              <span className="text-ink-secondary"> · {d.ai.limits.perIpPerDay}/IP · {d.ai.limits.perWalletPerDay}/wallet · {d.ai.limits.perIpPerMinute}/min burst</span>
            </div>
            <div className={d.ai.spendUsd >= d.ai.budgetUsd ? "text-danger-fg" : "text-ink-secondary"}>
              ${d.ai.spendUsd.toFixed(3)} of ${d.ai.budgetUsd.toFixed(2)} estimated this month
            </div>
          </div>
        ) : (
          <p className="px-4 py-3 text-[13px] text-ink-secondary">No usage counters (storage not configured).</p>
        )}
      </Module>

      <Module>
        <ModuleHeader title="Stored rows" action={<span className="text-[11px] font-mono text-ink-muted">tables that grow</span>} />
        <dl className="px-4 py-3 grid grid-cols-2 md:grid-cols-3 gap-y-2 gap-x-4 text-[12px] font-mono">
          {Object.entries(d?.tables ?? {}).map(([t, n]) => (
            <Fact key={t} k={t} v={n === null ? "unreadable" : n.toLocaleString()} />
          ))}
          {Object.keys(d?.tables ?? {}).length === 0 && <span className="text-ink-secondary">—</span>}
        </dl>
      </Module>
    </div>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-muted">{k}</dt>
      <dd className="text-ink truncate">{v}</dd>
    </div>
  );
}
