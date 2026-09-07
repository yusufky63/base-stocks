"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge, Module, ModuleHeader, Stat } from "@/components/ui/primitives";
import { adminFetch, duration, type HealthResponse, type OverviewResponse } from "./client";

function lagTone(lag: number): "positive" | "warning" | "danger" {
  // The tail read covers 5k blocks, so anything under that is invisible to a reader; past 50k the
  // sweep is losing ground faster than a scheduled run can win it back.
  if (lag < 5_000) return "positive";
  return lag < 50_000 ? "warning" : "danger";
}

/**
 * What is wrong now, and what this deployment is doing.
 *
 * Alerts first because they are the reason to open the page; then the four numbers that decide
 * whether to act — how far the transfer index is behind, what the keeper has left to spend, how
 * many distinct errors landed in the hour, and whether storage answers. Provider counters sit
 * under them: the per-instance call and latency record, which is where a slow page usually
 * explains itself.
 */
export function HealthPanel({ token }: { token: string }) {
  const health = useQuery({ queryKey: ["admin", "health", token], queryFn: () => adminFetch<HealthResponse>(token, "/api/health"), refetchInterval: 60_000 });
  const overview = useQuery({ queryKey: ["admin", "overview", token], queryFn: () => adminFetch<OverviewResponse>(token, "/api/admin/overview"), refetchInterval: 120_000 });

  const h = health.data;
  const index = overview.data && !("error" in overview.data.index) ? overview.data.index : null;
  const alerts = h?.alerts ?? [];

  return (
    <div className="flex flex-col gap-6">
      <Module>
        <ModuleHeader title="Alerts" action={<Badge tone={alerts.length === 0 ? "positive" : "danger"}>{alerts.length === 0 ? "all clear" : `${alerts.length} alert${alerts.length === 1 ? "" : "s"}`}</Badge>} />
        <div className="px-4 py-3 text-[13px] flex flex-col gap-1.5">
          {alerts.length === 0 && <span className="text-ink-secondary">Nothing is failing the monitor&apos;s checks: storage answers, the keeper can pay for gas, no service is down and the hour was quiet.</span>}
          {alerts.map((a) => (
            <div key={a} className="text-danger-fg">
              {a}
            </div>
          ))}
        </div>
      </Module>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Module className="p-4">
          <Stat label="Index lag" value={index ? `${index.lag.toLocaleString()} blk` : "—"} sub={index ? `${duration(index.lagSeconds)} behind · ${index.wallets} wallets` : "unread"} />
          {index && <Badge tone={lagTone(index.lag)} className="mt-2">{lagTone(index.lag) === "positive" ? "keeping up" : lagTone(index.lag) === "warning" ? "behind" : "run the sweep"}</Badge>}
        </Module>
        <Module className="p-4">
          <Stat label="Keeper" value={h?.keeper?.eth ? `${Number(h.keeper.eth).toFixed(4)} ETH` : h?.keeper ? "unknown" : "not set"} sub={overview.data ? `${overview.data.automation.onchainPlans} onchain plan(s)` : ""} />
        </Module>
        <Module className="p-4">
          <Stat label="Errors / hour" value={h ? String(h.errors.lastHour) : "—"} sub="distinct, last 60 min" />
        </Module>
        <Module className="p-4">
          <Stat label="Storage" value={h ? (h.storage.tablesReady === false ? "missing" : h.storage.backend) : "—"} sub={h?.storage.tablesReady === false ? h.storage.missing.join(", ") : "tables ready"} />
        </Module>
      </div>

      <Module>
        <ModuleHeader title="Deployment" />
        <dl className="px-4 py-3 grid grid-cols-2 md:grid-cols-4 gap-y-2 gap-x-4 text-[12px] font-mono">
          <Fact k="commit" v={h?.deploy.commit ?? "local"} />
          <Fact k="region" v={h?.deploy.region ?? "—"} />
          <Fact k="sessions" v={h?.auth.persistentSessions ? "persistent" : "per-instance"} />
          <Fact k="node env" v={overview.data?.settings.nodeEnv ?? "—"} />
          {index && <Fact k="chain head" v={index.head.toLocaleString()} />}
          {index && <Fact k="index cursor" v={index.cursor === null ? "unset" : index.cursor.toLocaleString()} />}
          {overview.data && <Fact k="auto rules" v={String(overview.data.automation.autoRules)} />}
          {overview.data && <Fact k="runs / tick" v={String(overview.data.automation.maxRunsPerTick)} />}
        </dl>
        {(h?.schemaMissingSeen.length ?? 0) > 0 && <p className="px-4 py-2 border-t border-line text-[12px] text-warning-fg">Schema gaps seen since boot: {h!.schemaMissingSeen.join(", ")}</p>}
      </Module>

      <Module>
        <ModuleHeader title="Providers" action={<span className="text-[11px] font-mono text-ink-muted">this instance, since boot</span>} />
        {!h?.providers || Object.keys(h.providers).length === 0 ? (
          <p className="px-4 py-4 text-[13px] text-ink-secondary">No upstream call has been made by the instance answering this request yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] font-mono">
              <thead className="text-ink-muted">
                <tr className="border-b border-line">
                  <th className="text-left font-normal px-4 py-2">provider</th>
                  <th className="text-right font-normal px-2 py-2">calls</th>
                  <th className="text-right font-normal px-2 py-2">errors</th>
                  <th className="text-right font-normal px-2 py-2">avg ms</th>
                  <th className="text-right font-normal px-2 py-2">breaker</th>
                  <th className="text-left font-normal px-4 py-2">last error</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(h.providers)
                  .sort((a, b) => b[1].calls - a[1].calls)
                  .map(([name, s]) => (
                    <tr key={name} className="border-b border-line last:border-b-0">
                      <td className="px-4 py-1.5 text-ink">{name}</td>
                      <td className="px-2 py-1.5 text-right num">{s.calls}</td>
                      <td className={`px-2 py-1.5 text-right num ${s.errors > 0 ? "text-danger-fg" : "text-ink-muted"}`}>{s.errors}</td>
                      <td className="px-2 py-1.5 text-right num">{s.avgLatencyMs}</td>
                      <td className={`px-2 py-1.5 text-right num ${s.breakerOpens > 0 ? "text-warning-fg" : "text-ink-muted"}`}>{s.breakerOpens}</td>
                      <td className="px-4 py-1.5 text-ink-muted truncate max-w-[280px]">{s.lastError ?? "—"}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
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
