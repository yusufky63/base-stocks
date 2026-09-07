"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Chip, Module, ModuleHeader, PageTitle } from "@/components/ui/primitives";
import { Input } from "@/components/ui/Input";
import { adminFetch, utc, type HealthResponse } from "./client";
import { HealthPanel } from "./HealthPanel";
import { ErrorsPanel } from "./ErrorsPanel";
import { JobsPanel } from "./JobsPanel";
import { AssetsPanel } from "./AssetsPanel";
import { ConfigPanel } from "./ConfigPanel";

const TABS = ["Health", "Errors", "Jobs", "Assets", "Config"] as const;
type Tab = (typeof TABS)[number];

const STORAGE_KEY = "bstocks:admin";

/**
 * The operations console.
 *
 * It used to be one page that asked for a token, summarised health in a sentence and listed
 * discovered tokens. Everything an incident actually needs was somewhere else: the maintenance
 * jobs behind a shared cron secret in a terminal, the provider counters returned by `/api/health`
 * and never rendered, error stacks nowhere at all, and the answer to "what is this deployment
 * configured to do" only in Vercel's settings. Those are five questions, so this is five tabs
 * behind one token, and the header answers the first one — is anything wrong — before you pick.
 */
export function AdminView() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string>(() => (typeof window !== "undefined" ? (sessionStorage.getItem(STORAGE_KEY) ?? "") : ""));
  const [token, setToken] = useState<string>(draft);
  const [tab, setTab] = useState<Tab>("Health");

  const health = useQuery({
    queryKey: ["admin", "health", token],
    queryFn: () => adminFetch<HealthResponse>(token, "/api/health"),
    enabled: !!token,
    refetchInterval: 60_000,
    retry: false,
  });

  const authorized = !!token && !!health.data;
  const alerts = health.data?.alerts.length ?? 0;

  if (!authorized) {
    return (
      <div className="flex flex-col gap-6 max-w-[560px]">
        <PageTitle index="Admin" title="Operations" lead="Health, errors, maintenance jobs, asset verification and configuration. The admin token never leaves this browser session." />
        <Module>
          <ModuleHeader title="Access" />
          <form
            className="p-4 flex flex-col md:flex-row gap-2 md:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              sessionStorage.setItem(STORAGE_KEY, draft);
              setToken(draft);
            }}
          >
            <Input label="Admin token" type="password" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} className="md:w-[360px]" />
            <Button type="submit" loading={health.isFetching}>
              Unlock
            </Button>
          </form>
          {health.isError && <p className="px-4 pb-4 text-[13px] text-danger-fg">{(health.error as Error).message}</p>}
        </Module>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 max-w-[1000px]">
      <PageTitle
        index="Admin"
        title="Operations"
        lead={health.data?.deploy.commit ? `Deploy ${health.data.deploy.commit}${health.data.deploy.region ? ` · ${health.data.deploy.region}` : ""} · checked ${utc(health.data.time)} UTC` : undefined}
        action={
          <div className="flex items-center gap-2">
            <Badge tone={alerts === 0 ? "positive" : "danger"}>{alerts === 0 ? "healthy" : `${alerts} alert${alerts === 1 ? "" : "s"}`}</Badge>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                sessionStorage.removeItem(STORAGE_KEY);
                qc.removeQueries({ queryKey: ["admin"] });
                setToken("");
              }}
            >
              Lock
            </Button>
          </div>
        }
      />
      <nav className="flex flex-wrap gap-2" aria-label="Admin sections">
        {TABS.map((t) => (
          <Chip key={t} active={tab === t} onClick={() => setTab(t)}>
            {t}
            {t === "Health" && alerts > 0 && <span className="ml-1.5 text-danger-fg num">{alerts}</span>}
            {t === "Errors" && (health.data?.errors.lastHour ?? 0) > 0 && <span className="ml-1.5 text-warning-fg num">{health.data!.errors.lastHour}</span>}
          </Chip>
        ))}
      </nav>
      {tab === "Health" && <HealthPanel token={token} />}
      {tab === "Errors" && <ErrorsPanel token={token} />}
      {tab === "Jobs" && <JobsPanel token={token} />}
      {tab === "Assets" && <AssetsPanel token={token} />}
      {tab === "Config" && <ConfigPanel token={token} />}
    </div>
  );
}
