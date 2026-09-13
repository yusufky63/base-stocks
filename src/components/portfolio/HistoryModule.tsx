"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type { PortfolioCurve, CurveWindow } from "@/services/portfolio-curve-service";
import { apiGet } from "@/lib/client-api";
import { formatUsd, formatPct } from "@/lib/format";
import { Module, ModuleHeader, Skeleton, cx } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/Segmented";
import { Sparkline } from "@/components/ui/Sparkline";

type Range = CurveWindow | "ALL";

const RANGES: Array<{ value: Range; label: string }> = [
  { value: "1D", label: "1D" },
  { value: "1W", label: "1W" },
  { value: "1M", label: "1M" },
  { value: "ALL", label: "All" },
];

/**
 * Two different charts behind one control, and the difference is stated rather than blurred.
 *
 * 1D / 1W / 1M price the stocks held *right now* back through the Chainlink reference: it answers
 * "how has what I hold moved", and buys, sells and gifts are invisible in it. All is the daily
 * snapshot record — what the account was actually worth, deposits and trades included — which only
 * exists from the day the wallet first opened this page.
 */
export function HistoryModule({ address }: { address: Address }) {
  const [range, setRange] = useState<Range>("1D");

  const curve = useQuery({
    queryKey: ["portfolio", "curve", address.toLowerCase(), range],
    queryFn: () => apiGet<{ curve: PortfolioCurve }>(`/api/portfolio/${address}/curve?window=${range}`).then((r) => r.curve),
    enabled: range !== "ALL",
    staleTime: 60_000,
  });

  const snapshots = useQuery({
    queryKey: ["portfolio", "history", address.toLowerCase()],
    queryFn: () => apiGet<{ points: Array<{ day: string; totalUsd: number }> }>(`/api/portfolio/${address}/history?days=365`),
    enabled: range === "ALL",
    staleTime: 5 * 60_000,
  });

  const loading = range === "ALL" ? snapshots.isLoading : curve.isLoading;
  const series = range === "ALL" ? (snapshots.data?.points ?? []).map((p) => p.totalUsd) : (curve.data?.points ?? []).map((p) => p.usd);
  const last = series[series.length - 1] ?? null;
  // "All" carries no percentage: the line moves with deposits, withdrawals and trades as much as
  // with prices, so (last - first) / first is not a return on anything, and colouring it green
  // told people they had made money they had in fact deposited.
  const changePct = range === "ALL" ? null : (curve.data?.changePct ?? null);
  // The reference history does not always reach the start of the window asked for; say where it begins.
  const shortCoverage = range !== "ALL" && curve.data?.coverageFrom != null && curve.data.coverageFrom > curve.data.windowFrom + 60 * 60_000 ? new Date(curve.data.coverageFrom) : null;
  const bench = range !== "ALL" ? (curve.data?.benchmark ?? null) : null;
  const versus = bench && bench.changePct !== null && changePct !== null ? changePct - bench.changePct : null;

  const header = (
    <ModuleHeader
      index="H"
      title="Value history"
      action={<Segmented<Range> size="sm" className="w-[224px] shrink-0" ariaLabel="History range" value={range} onChange={setRange} options={RANGES} />}
    />
  );

  if (loading) {
    return (
      <Module>
        {header}
        <div className="p-4">
          <Skeleton className="h-[72px]" />
        </div>
      </Module>
    );
  }

  if (series.length < 2) {
    return (
      <Module>
        {header}
        <p className="px-4 py-4 text-[13px] text-ink-secondary">
          {range === "ALL"
            ? "The account's own value history starts the first day this page is opened, and builds from there. Pick 1D to see how what you hold has moved in the meantime."
            : "Nothing to chart yet: no stock with a reference feed is held in this wallet."}
        </p>
      </Module>
    );
  }

  return (
    <Module>
      {header}
      <div className="p-4 flex items-center justify-between gap-4">
        <Sparkline points={series} compare={bench?.points} width={260} height={72} />
        <div className="text-right">
          <div className="display num text-[22px]">{formatUsd(last)}</div>
          {range === "ALL" ? (
            <div className="text-[12px] font-mono num text-ink-secondary">account value</div>
          ) : (
            <div className={cx("text-[12px] font-mono num", (changePct ?? 0) > 0 ? "text-positive-fg" : (changePct ?? 0) < 0 ? "text-danger-fg" : "text-ink-secondary")}>
              {formatPct(changePct, { sign: true })}
            </div>
          )}
          {bench && (
            <div className="text-[11px] font-mono num text-ink-muted mt-0.5" title={`${bench.name}: every listed stock with a reference feed, equal-weighted, over the same window`}>
              <span className="inline-block w-3 border-t border-dashed border-ink-muted align-middle mr-1" aria-hidden />
              index {formatPct(bench.changePct, { sign: true })}
              {versus !== null && <span className={cx("ml-1", versus > 0 ? "text-positive-fg" : versus < 0 ? "text-danger-fg" : "")}>({formatPct(versus, { sign: true })} vs)</span>}
            </div>
          )}
        </div>
      </div>
      <p className="px-4 py-2.5 text-[11px] text-ink-muted border-t border-line">
        {range === "ALL"
          ? `What the account was worth, from ${snapshots.data?.points[0]?.day ?? "the first visit"} — deposits and trades included, so the change is not a return.`
          : "What you hold today, priced back through the Chainlink reference. Buys, sells and gifts do not appear; pick All for the account's own record."}
        {range !== "ALL" && bench && ` The dashed line is the ${bench.name.toLowerCase()} index of the listed stocks over the same window, started at your value: a comparison, not a target.`}
        {shortCoverage && ` Reference history covers from ${shortCoverage.toISOString().slice(0, 10)}; the line starts there.`}
        {range !== "ALL" && curve.data?.flat && " The reference has not moved in this window — stock feeds are 24/5."}
        {range !== "ALL" && (curve.data?.missing.length ?? 0) > 0 && ` ${curve.data!.missing.join(", ")} left out: no reference feed to price ${curve.data!.missing.length > 1 ? "them" : "it"} back.`}
      </p>
    </Module>
  );
}
