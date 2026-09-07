"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge, Button, Module, ModuleHeader } from "@/components/ui/primitives";
import { Input } from "@/components/ui/Input";
import { adminFetch, type JobRun } from "./client";

interface JobInfo {
  job: string;
  description: string;
}

/**
 * Run a maintenance job now.
 *
 * These are the jobs the scheduler runs; the reason to have them here is the fifteen minutes
 * between scheduled runs. When the index cursor has fallen behind, or a reconciliation has to be
 * repeated after a provider outage, the alternative was a shared cron secret in a terminal. The
 * result — how long it took and what it returned — is shown verbatim, because the returned
 * numbers (`more`, `added`, `written`) are what say whether to press it again.
 */
export function JobsPanel({ token }: { token: string }) {
  const [blocks, setBlocks] = useState("5000");
  const [runs, setRuns] = useState<Record<string, JobRun>>({});
  const list = useQuery({ queryKey: ["admin", "jobs", token], queryFn: () => adminFetch<{ jobs: JobInfo[]; defaultSweepBlocks: number }>(token, "/api/admin/jobs") });
  const run = useMutation({
    mutationFn: (job: string) => adminFetch<JobRun>(token, "/api/admin/jobs", { method: "POST", body: JSON.stringify({ job, ...(job === "index" ? { blocks: Number(blocks) || undefined } : {}) }) }),
    onSuccess: (r) => setRuns((prev) => ({ ...prev, [r.job]: r })),
    onError: (err, job) => setRuns((prev) => ({ ...prev, [job]: { ok: false, job, ms: 0, error: (err as Error).message } })),
  });

  return (
    <Module>
      <ModuleHeader title="Maintenance" action={<span className="text-[11px] font-mono text-ink-muted">one job per call · 60 s budget</span>} />
      <div className="px-4 py-3 border-b border-line flex flex-wrap items-end gap-3">
        <Input label="Sweep budget (blocks)" value={blocks} onChange={(e) => setBlocks(e.target.value.replace(/[^0-9]/g, ""))} className="w-[180px]" hint="Used by the index job only." />
        <p className="text-[12px] text-ink-secondary max-w-[420px]">
          The scheduler runs the time-sensitive jobs every fifteen minutes on its own. Use these when you cannot wait for the next run, or to walk a stalled cursor forward: keep pressing <span className="font-mono">index</span> while the result says{" "}
          <span className="font-mono">more: true</span>.
        </p>
      </div>
      {list.error && <p className="px-4 py-3 text-[13px] text-danger-fg">{(list.error as Error).message}</p>}
      <ul className="divide-y divide-line">
        {(list.data?.jobs ?? []).map((j) => {
          const r = runs[j.job];
          const pending = run.isPending && run.variables === j.job;
          return (
            <li key={j.job} className="px-4 py-3 flex flex-col gap-2">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[13px] text-ink">{j.job}</span>
                    {r && <Badge tone={r.ok ? "positive" : "danger"}>{r.ok ? `${r.ms} ms` : "failed"}</Badge>}
                  </div>
                  <p className="text-[12px] text-ink-secondary mt-0.5">{j.description}</p>
                </div>
                <Button size="sm" variant="secondary" loading={pending} onClick={() => run.mutate(j.job)}>
                  Run
                </Button>
              </div>
              {r?.error && <p className="text-[12px] font-mono text-danger-fg break-words">{r.error}</p>}
              {r && !r.error && <pre className="p-2.5 rounded-[6px] bg-surface-muted text-[11px] leading-relaxed overflow-x-auto whitespace-pre-wrap text-ink-secondary">{JSON.stringify(r.result, null, 2)}</pre>}
            </li>
          );
        })}
      </ul>
    </Module>
  );
}
