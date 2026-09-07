"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Chip, Module, ModuleHeader } from "@/components/ui/primitives";
import { adminFetch, utc, type AdminError } from "./client";

const WINDOWS = [
  { hours: 1, label: "1 h" },
  { hours: 24, label: "24 h" },
  { hours: 168, label: "7 d" },
] as const;

/**
 * The recorded errors, readable rather than merely listed.
 *
 * Three things the health summary could not do: a longer window, the stack for the row you are
 * reading, and a way to forget one. Dismissing matters more than it sounds — a fixed error keeps
 * its row for a day, so without this the list slowly fills with things already dealt with and
 * stops being the place you look during an incident.
 */
export function ErrorsPanel({ token }: { token: string }) {
  const qc = useQueryClient();
  const [hours, setHours] = useState<number>(24);
  const [open, setOpen] = useState<string | null>(null);

  const errors = useQuery({
    queryKey: ["admin", "errors", token, hours],
    queryFn: () => adminFetch<{ errors: AdminError[] }>(token, `/api/admin/errors?hours=${hours}&limit=100`),
    refetchInterval: 60_000,
  });
  const clear = useMutation({
    mutationFn: (q: string) => adminFetch<{ cleared: number }>(token, `/api/admin/errors?${q}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "errors"] }),
  });

  const rows = errors.data?.errors ?? [];
  const bySource = rows.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.source]: (acc[e.source] ?? 0) + 1 }), {});

  return (
    <Module>
      <ModuleHeader
        title="Errors"
        action={
          <div className="flex items-center gap-2">
            {WINDOWS.map((w) => (
              <Chip key={w.hours} active={hours === w.hours} onClick={() => setHours(w.hours)} className="h-7 px-2 text-[12px]">
                {w.label}
              </Chip>
            ))}
          </div>
        }
      />
      <div className="px-4 py-2.5 border-b border-line flex flex-wrap items-center gap-3 text-[12px] font-mono text-ink-muted">
        <span>
          {rows.length} distinct{Object.entries(bySource).length > 0 ? ` · ${Object.entries(bySource).map(([s, n]) => `${n} ${s}`).join(" · ")}` : ""}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" loading={clear.isPending} disabled={rows.length === 0} onClick={() => clear.mutate("olderThanHours=24")}>
            Clear older than 24 h
          </Button>
          <Button size="sm" variant="ghost" loading={clear.isPending} disabled={rows.length === 0} onClick={() => clear.mutate("olderThanHours=0")}>
            Clear all
          </Button>
        </span>
      </div>
      {clear.error && <p className="px-4 py-2 text-[12px] text-danger-fg">{(clear.error as Error).message}</p>}
      {errors.isLoading && <p className="px-4 py-4 text-[13px] text-ink-secondary">Reading…</p>}
      {!errors.isLoading && rows.length === 0 && <p className="px-4 py-6 text-[14px] text-ink-secondary">Nothing recorded in this window.</p>}
      <ul className="divide-y divide-line">
        {rows.map((e) => (
          <li key={e.fingerprint} className="px-4 py-2.5 text-[12px] font-mono flex flex-col gap-1">
            <span className="flex items-center gap-2">
              <Badge tone={e.source === "client" ? "warning" : "danger"}>{e.source}</Badge>
              <span className="text-ink-secondary truncate">{e.route ?? "—"}</span>
              <span className="ml-auto text-ink-muted num">×{e.count}</span>
            </span>
            <span className="text-ink break-words">{e.message}</span>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-muted">
              <span>last {utc(e.lastAt)} UTC</span>
              <span>first {utc(e.firstAt)} UTC</span>
              {e.digest && <span>digest {e.digest}</span>}
              {e.stack && (
                <button type="button" className="underline hover:text-ink" onClick={() => setOpen(open === e.fingerprint ? null : e.fingerprint)}>
                  {open === e.fingerprint ? "hide stack" : "stack"}
                </button>
              )}
              <button type="button" className="underline hover:text-danger-fg" onClick={() => clear.mutate(`fingerprint=${e.fingerprint}`)}>
                dismiss
              </button>
            </span>
            {open === e.fingerprint && e.stack && <pre className="mt-1 p-2.5 rounded-[6px] bg-surface-muted text-[11px] leading-relaxed overflow-x-auto whitespace-pre text-ink-secondary">{e.stack}</pre>}
          </li>
        ))}
      </ul>
    </Module>
  );
}
