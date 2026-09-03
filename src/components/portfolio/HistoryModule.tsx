"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { apiGet } from "@/lib/client-api";
import { formatUsd, formatPct } from "@/lib/format";
import { Module, ModuleHeader } from "@/components/ui/primitives";
import { Sparkline } from "@/components/ui/Sparkline";

/** Portfolio value history from daily snapshots (recorded on each visit). */
export function HistoryModule({ address }: { address: Address }) {
  const { data } = useQuery({ queryKey: ["portfolio", "history", address.toLowerCase()], queryFn: () => apiGet<{ points: Array<{ day: string; totalUsd: number }> }>(`/api/portfolio/${address}/history?days=90`), staleTime: 5 * 60_000 });
  const points = data?.points ?? [];
  const first = points[0]?.totalUsd ?? null;
  const last = points[points.length - 1]?.totalUsd ?? null;
  const change = first && last ? ((last - first) / first) * 100 : null;
  return (
    <Module>
      <ModuleHeader index="H" title="Value history" action={<span className="font-mono text-[11px] text-ink-muted">{points.length} days</span>} />
      {points.length < 2 ? (
        <p className="px-4 py-4 text-[13px] text-ink-secondary">History builds up daily as you visit; come back tomorrow for the first line.</p>
      ) : (
        <div className="p-4 flex items-center justify-between gap-4">
          <Sparkline points={points.map((p) => p.totalUsd)} width={260} height={72} />
          <div className="text-right">
            <div className="display num text-[22px]">{formatUsd(last)}</div>
            <div className="text-[12px] font-mono text-ink-secondary">
              {formatPct(change, { sign: true })} since {points[0]!.day}
            </div>
          </div>
        </div>
      )}
    </Module>
  );
}
