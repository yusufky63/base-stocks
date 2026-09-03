"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ExternalLink } from "lucide-react";
import { apiGet } from "@/lib/client-api";
import { timeAgo } from "@/lib/format";
import { Module, ModuleHeader, PageTitle, Skeleton, cx } from "@/components/ui/primitives";
import { Collapsible } from "@/components/ui/Collapsible";
import { TimeAgo } from "@/components/common/TimeAgo";

type ServiceStatus = "ok" | "degraded" | "down" | "off";
interface ServiceCheck {
  id: string;
  group: string;
  name: string;
  status: ServiceStatus;
  /** Raw result of the latest probe before smoothing. */
  raw?: ServiceStatus;
  /** Oldest → newest, up to the last 12 probes. */
  history?: ServiceStatus[];
  latencyMs: number | null;
  detail: string;
  url?: string;
}
interface StatusReport {
  overall: ServiceStatus;
  checks: ServiceCheck[];
  metrics: Record<string, { calls: number; errors: number; avgLatencyMs: number; breakerOpens: number; lastError?: string }>;
  breakers: Array<{ name: string; open: boolean; openUntil: number }>;
  generatedAt: number;
  uptimeSeconds: number;
}

const GROUPS = ["Chain", "Prices & charts", "Trading", "Earn", "News", "Identity", "Storage & AI"];
const LABEL: Record<ServiceStatus, string> = { ok: "Operational", degraded: "Degraded", down: "Outage", off: "Not enabled" };
const DOT: Record<ServiceStatus, string> = { ok: "bg-positive-fg", degraded: "bg-warning-fg", down: "bg-danger-fg", off: "bg-ink-muted/50" };
const TEXT: Record<ServiceStatus, string> = { ok: "text-positive-fg", degraded: "text-warning-fg", down: "text-danger-fg", off: "text-ink-muted" };

/**
 * Classic status page: one verdict, grouped components with a dot and a word, recent history as
 * small bars, details on demand. Probes run server-side at most once a minute (and every five
 * minutes in the background); a single failed probe reads as "degraded", an outage needs two in a row.
 */
export function StatusView() {
  const { data, isLoading, isError } = useQuery({ queryKey: ["status"], queryFn: () => apiGet<StatusReport>("/api/status"), refetchInterval: 60_000, staleTime: 30_000 });
  const overall = data?.overall ?? "ok";
  const active = data ? data.checks.filter((c) => c.status !== "off") : [];
  const affected = active.filter((c) => c.status !== "ok");

  return (
    <div className="flex flex-col gap-6">
      <PageTitle index="Status" title="Service status" lead="Everything this app depends on, probed from the server." />

      <div className={cx("border rounded-[8px] p-4 md:p-5 flex flex-wrap items-center gap-4", overall === "ok" ? "border-positive-fg/40 bg-positive-fg/5" : overall === "degraded" ? "border-warning-fg/50 bg-warning-fg/5" : "border-danger-fg/50 bg-danger-fg/5")}>
        <span className={cx("inline-block w-3 h-3 rounded-full", DOT[overall])} aria-hidden />
        <div className="min-w-0">
          <div className="display text-[22px] md:text-[28px] leading-none">{isLoading && !data ? "Checking…" : overall === "ok" ? "All systems operational" : overall === "degraded" ? "Some services degraded" : "Service disruption"}</div>
          {data && affected.length > 0 && <div className="mt-1 text-[13px] text-ink-secondary">{affected.map((c) => `${c.name}: ${LABEL[c.status].toLowerCase()}`).join(" · ")}</div>}
        </div>
        {data && (
          <span className="ml-auto font-mono text-[11px] uppercase tracking-[0.06em] text-ink-muted">
            checked <TimeAgo value={data.generatedAt} /> · {active.length} components
          </span>
        )}
      </div>

      {isError && <p className="text-[14px] text-danger-fg">Status could not be loaded.</p>}
      {isLoading && !data && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      )}

      {data &&
        GROUPS.map((g) => {
          const rows = data.checks.filter((c) => c.group === g);
          if (rows.length === 0) return null;
          const worst: ServiceStatus = rows.some((r) => r.status === "down") ? "down" : rows.some((r) => r.status === "degraded") ? "degraded" : "ok";
          return (
            <Module key={g}>
              <ModuleHeader
                title={g}
                action={
                  <span className={cx("font-mono text-[11px] uppercase tracking-[0.06em] inline-flex items-center gap-1.5", TEXT[worst])}>
                    <span className={cx("inline-block w-2 h-2 rounded-full", DOT[worst])} aria-hidden /> {LABEL[worst]}
                  </span>
                }
              />
              <ul className="divide-y divide-line">
                {rows.map((c) => (
                  <StatusRow key={c.id} c={c} />
                ))}
              </ul>
            </Module>
          );
        })}

      {data && (
        <Collapsible title="Diagnostics · process counters and circuit breakers">
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] font-mono">
              <thead>
                <tr className="text-ink-muted uppercase tracking-[0.06em] text-[10px]">
                  <th className="text-left px-4 py-2">provider</th>
                  <th className="text-right px-2 py-2">calls</th>
                  <th className="text-right px-2 py-2">errors</th>
                  <th className="text-right px-2 py-2">avg ms</th>
                  <th className="text-right px-2 py-2">breaker opens</th>
                  <th className="text-left px-4 py-2">last error</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.metrics)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([name, m]) => (
                    <tr key={name} className="border-t border-line">
                      <td className="px-4 py-1.5">{name}</td>
                      <td className="text-right px-2 py-1.5 num">{m.calls}</td>
                      <td className={cx("text-right px-2 py-1.5 num", m.errors > 0 && "text-warning-fg")}>{m.errors}</td>
                      <td className="text-right px-2 py-1.5 num">{m.avgLatencyMs}</td>
                      <td className="text-right px-2 py-1.5 num">{m.breakerOpens}</td>
                      <td className="px-4 py-1.5 text-ink-muted truncate max-w-[360px]">{m.lastError ?? ""}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-3 text-[12px] text-ink-muted border-t border-line">
            Counters are per server process (uptime {Math.floor(data.uptimeSeconds / 3600)}h {Math.floor((data.uptimeSeconds % 3600) / 60)}m) and reset on deploy. News sources are passive: they reflect fetches already made. Updated {timeAgo(data.generatedAt)}.
          </p>
        </Collapsible>
      )}
    </div>
  );
}

function StatusRow({ c }: { c: ServiceCheck }) {
  const [open, setOpen] = useState(false);
  const history = c.history ?? [];
  return (
    <li>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-surface transition-fast">
        <span className={cx("inline-block w-2.5 h-2.5 rounded-full shrink-0", DOT[c.status])} aria-label={LABEL[c.status]} />
        <span className="font-medium text-[14px] min-w-0 flex-1 truncate">{c.name}</span>
        <span className="hidden sm:inline-flex items-end gap-[3px]" aria-label={history.length ? `last ${history.length} probes` : undefined}>
          {history.map((h, i) => (
            <span key={i} className={cx("inline-block w-[5px] h-3 rounded-[1px]", DOT[h])} title={LABEL[h]} />
          ))}
        </span>
        <span className={cx("font-mono text-[10px] uppercase tracking-[0.08em] w-[92px] text-right shrink-0", TEXT[c.status])}>{LABEL[c.status]}</span>
        <ChevronDown size={14} strokeWidth={1.75} className={cx("text-ink-muted shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="px-4 pb-3 pl-[38px] text-[12px] text-ink-secondary flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="break-words">{c.detail}</span>
          {c.raw && c.raw !== c.status && <span className="text-ink-muted">latest probe: {LABEL[c.raw].toLowerCase()} (one failure is not counted as an outage)</span>}
          {c.latencyMs !== null && <span className="font-mono text-ink-muted">{c.latencyMs} ms</span>}
          {c.url && (
            <a href={c.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary font-medium">
              provider <ExternalLink size={11} strokeWidth={1.75} />
            </a>
          )}
        </div>
      )}
    </li>
  );
}
