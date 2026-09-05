"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Module, ModuleHeader, Button, Badge, PageTitle } from "@/components/ui/primitives";
import { Input } from "@/components/ui/Input";
import { AddressLabel } from "@/components/common/display";
import type { Address } from "viem";

interface Discovered {
  address: Address;
  name: string;
  symbol: string;
  blockNumber: number;
  verification: "discovered" | "verified" | "disabled";
  underlying?: string;
  chainlinkFeed?: string;
  eligible?: boolean;
  autoVerified?: boolean;
  reason?: string;
  creator?: string;
  updatedAt: number;
}

interface HealthResponse {
  storage: { backend: string; tablesReady: boolean | null; missing: string[] };
  keeper: { address: string; eth: string | null } | null;
  errors: { lastHour: number };
  alerts: string[];
  recentErrors?: Array<{ fingerprint: string; source: string; route?: string; message: string; count: number; lastAt: number; digest?: string }>;
}

async function adminFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", "x-admin-token": token, ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body as T;
}

/** Admin: discover `B20Created` tokens and control their verification state (spec §6). */
export function AdminView() {
  const [token, setToken] = useState<string>(() => (typeof window !== "undefined" ? sessionStorage.getItem("bstocks:admin") ?? "" : ""));
  const [active, setActive] = useState<string>(token);
  const health = useQuery({ queryKey: ["admin", "health", active], queryFn: () => adminFetch<HealthResponse>(active, "/api/health"), enabled: !!active, refetchInterval: 60_000 });
  const discover = useMutation({ mutationFn: () => adminFetch<{ discovered: Discovered[]; all: Discovered[] }>(active, "/api/admin/assets/discover", { method: "POST" }) });
  const setState = useMutation({
    mutationFn: (v: { address: Address; verification: Discovered["verification"] }) => adminFetch(active, "/api/admin/assets/discover", { method: "PATCH", body: JSON.stringify(v) }),
    onSuccess: () => discover.mutate(),
  });

  return (
    <div className="flex flex-col gap-6 max-w-[900px]">
      <PageTitle index="Admin" title="Asset verification" lead="Newly discovered B20 tokens stay non-tradable until verified here. The admin token never leaves this browser session." />
      <Module>
        <ModuleHeader title="Access" />
        <div className="p-4 flex flex-col md:flex-row gap-2 md:items-end">
          <Input label="Admin token" type="password" value={token} onChange={(e) => setToken(e.target.value)} className="md:w-[360px]" />
          <Button
            onClick={() => {
              sessionStorage.setItem("bstocks:admin", token);
              setActive(token);
            }}
          >
            Use token
          </Button>
          {health.isError && <span className="text-[13px] text-danger-fg">Unauthorized</span>}
          {health.data && <Badge tone="positive">authorized</Badge>}
        </div>
      </Module>
      {active && health.data && (
        <Module>
          <ModuleHeader title="Health" action={<Badge tone={health.data.alerts.length === 0 ? "positive" : "danger"}>{health.data.alerts.length === 0 ? "no alerts" : `${health.data.alerts.length} alert${health.data.alerts.length === 1 ? "" : "s"}`}</Badge>} />
          <div className="px-4 py-3 text-[13px] flex flex-col gap-1.5">
            {health.data.alerts.map((a) => (
              <div key={a} className="text-danger-fg">{a}</div>
            ))}
            <div className="text-ink-secondary">
              Storage {health.data.storage.backend}
              {health.data.storage.tablesReady === false ? ` · missing ${health.data.storage.missing.join(", ")}` : " · tables ready"}
              {health.data.keeper ? ` · keeper ${health.data.keeper.eth ? `${Number(health.data.keeper.eth).toFixed(5)} ETH` : "balance unknown"}` : " · no keeper"}
              {` · ${health.data.errors.lastHour} error${health.data.errors.lastHour === 1 ? "" : "s"} in the last hour`}
            </div>
          </div>
          {(health.data.recentErrors ?? []).length > 0 && (
            <ul className="divide-y divide-line border-t border-line">
              {health.data.recentErrors!.map((e) => (
                <li key={e.fingerprint} className="px-4 py-2 text-[12px] font-mono flex flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <Badge tone={e.source === "client" ? "warning" : "danger"}>{e.source}</Badge>
                    <span className="text-ink-secondary truncate">{e.route ?? "—"}</span>
                    <span className="ml-auto text-ink-muted num">×{e.count}</span>
                  </span>
                  <span className="text-ink break-words">{e.message}</span>
                  <span className="text-ink-muted">last {new Date(e.lastAt).toISOString().replace("T", " ").slice(0, 19)} UTC{e.digest ? ` · ${e.digest}` : ""}</span>
                </li>
              ))}
            </ul>
          )}
          {(health.data.recentErrors ?? []).length === 0 && <p className="px-4 py-3 border-t border-line text-[12px] text-ink-muted">No errors recorded in the last 24 hours.</p>}
        </Module>
      )}
      {active && (
        <Module>
          <ModuleHeader title="Discovered tokens" action={<Button size="sm" loading={discover.isPending} onClick={() => discover.mutate()}>Scan B20Created</Button>} />
          {discover.error && <p className="px-4 py-3 text-[13px] text-danger-fg">{(discover.error as Error).message}</p>}
          {(discover.data?.all ?? []).length === 0 && <p className="px-4 py-4 text-[14px] text-ink-secondary">Run a scan to list tokens created onchain that are not in the curated registry.</p>}
          {(discover.data?.all ?? []).map((d) => (
            <div key={d.address} className="flex items-center justify-between gap-3 px-4 py-3 border-b border-line last:border-b-0">
              <div className="min-w-0">
                <div className="font-medium text-[14px]">
                  {d.symbol} <span className="text-ink-secondary font-normal">{d.name}</span>
                  {d.eligible && <span className="ml-2 font-mono text-[10px] uppercase text-positive-fg">eligible · feed {d.chainlinkFeed?.slice(0, 8)}…</span>}
                  {d.autoVerified && <span className="ml-2 font-mono text-[10px] uppercase text-primary">auto-verified</span>}
                  {!d.eligible && d.reason && <span className="ml-2 font-mono text-[10px] text-ink-muted">{d.reason}</span>}
                </div>
                <AddressLabel address={d.address} explorer />
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={d.verification === "verified" ? "positive" : d.verification === "disabled" ? "danger" : "warning"}>{d.verification}</Badge>
                <Button size="sm" variant="secondary" onClick={() => setState.mutate({ address: d.address, verification: "verified" })}>
                  Verify
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setState.mutate({ address: d.address, verification: "disabled" })}>
                  Disable
                </Button>
              </div>
            </div>
          ))}
          <p className="px-4 py-3 text-[12px] text-ink-muted border-t border-line">Verified tokens still need a Chainlink feed and tags in the curated registry before they appear in Markets.</p>
        </Module>
      )}
    </div>
  );
}
