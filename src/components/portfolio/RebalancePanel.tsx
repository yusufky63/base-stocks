"use client";

import { useMemo } from "react";
import { CheckCircle2 } from "lucide-react";
import type { Allocation, PortfolioSnapshot } from "@/domain/portfolio";
import { USDC_ALLOCATION_KEY } from "@/domain/portfolio";
import type { AssetsResponse } from "@/lib/client-api";
import { driftRows, driftSummary, targetHasCash, type DriftRow } from "@/lib/portfolio/drift";
import { legBlockedReason } from "@/lib/trading-status";
import { bpsToPct, formatUsd } from "@/lib/format";
import { AssetLogo } from "@/components/common/display";
import { AllocationBar, ColorDot } from "@/components/common/AllocationBar";
import { Module, ModuleHeader, cx } from "@/components/ui/primitives";
import { Select } from "@/components/ui/Select";
import { RebalanceExecutor } from "./RebalanceExecutor";
import { MY_TARGET_ID, TargetControls, type SavedTarget } from "./TargetAllocation";
import { TowardTargetPlan } from "./TowardTargetPlan";

export interface TargetChoice {
  id: string;
  name: string;
  allocations: Allocation[];
}

/**
 * The Rebalance tab. One table answers three questions per leg — what you hold, what the target
 * wants, what would change — and one summary line says whether the sells fund the buys. Legs that
 * cannot trade today are shown greyed with the reason, never as a green "Buy" that fails later.
 */
export function RebalancePanel({
  snapshot,
  assets,
  target,
  choices,
  onChoose,
  saved,
}: {
  snapshot: PortfolioSnapshot;
  assets?: AssetsResponse;
  target?: TargetChoice;
  choices: TargetChoice[];
  onChoose: (id: string) => void;
  saved: SavedTarget;
}) {
  const lookup = (address: string) => assets?.assets.find((a) => a.canonicalId === address.toLowerCase());
  const rows = useMemo<DriftRow[]>(() => {
    if (!target) return [];
    return driftRows(snapshot, target.allocations, {
      symbolFor: (addr) => lookup(addr)?.underlying,
      blockedFor: (side, addr, usd) => {
        const asset = lookup(addr);
        if (!asset) return "not in the verified registry";
        return legBlockedReason(side, asset, assets?.prices[asset.canonicalId], usd);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, target, assets]);
  const summary = target ? driftSummary(snapshot, target.allocations, rows) : null;

  return (
    <Module>
      <ModuleHeader
        index="C"
        title="Drift against a target"
        action={
          <Select
            size="sm"
            className="w-[220px]"
            ariaLabel="Compare with"
            placeholder="Pick a target…"
            value={target?.id ?? ""}
            onChange={onChoose}
            options={choices.map((c) => ({ value: c.id, label: c.id === MY_TARGET_ID ? "My target" : c.name, description: c.id === MY_TARGET_ID ? "The mix you saved" : undefined }))}
          />
        }
      />
      {target && summary && rows.length > 0 ? (
        <div>
          <div className="px-4 py-3 border-b border-line">
            <AllocationBar height={8} segments={target.allocations.map((a) => ({ key: a.assetAddress, label: a.assetAddress === USDC_ALLOCATION_KEY ? "USDC" : (lookup(a.assetAddress)?.underlying ?? "?"), weightBps: a.weightBps }))} />
          </div>

          <div className="module-grid grid-cols-2 md:grid-cols-4 border-b border-line">
            <Cell label="Measured on" value={formatUsd(summary.base)} sub={targetHasCash(target.allocations) ? "stocks + cash" : "stocks only"} />
            <Cell label="Sell" value={formatUsd(summary.sellsUsd)} tone={summary.sellsUsd > 0 ? "danger" : undefined} />
            <Cell label="Buy" value={formatUsd(summary.buysUsd)} tone={summary.buysUsd > 0 ? "positive" : undefined} sub={summary.blockedUsd > 0 ? `+ ${formatUsd(summary.blockedUsd)} blocked` : undefined} />
            <Cell label="Cash after sells" value={formatUsd(summary.cashAfterSells)} sub={summary.shortfallUsd > 0 ? `${formatUsd(summary.shortfallUsd)} short` : "covers the buys"} tone={summary.shortfallUsd > 0 ? "danger" : undefined} />
          </div>

          {summary.inBalance ? (
            <div className="px-4 py-5 flex items-start gap-3">
              <CheckCircle2 size={18} strokeWidth={1.75} className="text-positive-fg shrink-0 mt-0.5" />
              <div>
                <div className="text-[14px] font-medium">In balance with {target.name}.</div>
                <div className="text-[13px] text-ink-secondary">Every leg is within the line where a trade would cost more than it fixes. Nothing to do.</div>
              </div>
            </div>
          ) : (
            <div>
              <div className="hidden md:grid grid-cols-[1fr_120px_120px_140px] gap-3 px-4 py-2 border-b border-line font-mono text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                <span>Leg</span>
                <span className="text-right">Now</span>
                <span className="text-right">Target</span>
                <span className="text-right">Change</span>
              </div>
              {rows.map((r) => (
                <Row key={String(r.assetAddress)} row={r} logo={r.assetAddress === USDC_ALLOCATION_KEY ? undefined : lookup(r.assetAddress as string)?.logoURI} />
              ))}
            </div>
          )}

          <RebalanceExecutor snapshot={snapshot} rows={rows} summary={summary} targetName={target.name} />
          <TargetControls snapshot={snapshot} target={target} saved={saved} />
          {target.id === MY_TARGET_ID && saved.signedIn && saved.allocations && !targetHasCash(saved.allocations) && <TowardTargetPlan allocations={saved.allocations} />}
          <p className="px-4 py-3 text-[12px] text-ink-muted border-t border-line">
            Suggestions only. Rebalancing is manual: every trade goes through the same quote, guard and wallet confirmation. A leg trades only when it is at least 1% of the measured value and $5 out of line. {target.id === MY_TARGET_ID ? "Your target is a note to yourself, not advice." : `${target.name} is a template, not a recommendation.`}
          </p>
        </div>
      ) : (
        <div className="px-4 py-6 flex flex-col gap-3">
          <p className="text-[14px] text-ink-secondary">{target ? "Nothing to compare yet: this wallet holds no priced stock." : "Pick a template to see how your holdings compare, or save the mix you are holding now as your own target and let the page tell you when it drifts."}</p>
          <TargetControls snapshot={snapshot} target={target} saved={saved} />
        </div>
      )}
    </Module>
  );
}

function Cell({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "positive" | "danger" }) {
  return (
    <div className="p-4 flex flex-col gap-1">
      <span className="eyebrow">{label}</span>
      <span className={cx("display num text-[20px] leading-none", tone === "positive" && "text-positive-fg", tone === "danger" && "text-danger-fg")}>{value}</span>
      {sub && <span className="text-[11px] text-ink-muted">{sub}</span>}
    </div>
  );
}

function Row({ row, logo }: { row: DriftRow; logo?: string }) {
  const cash = row.assetAddress === USDC_ALLOCATION_KEY;
  const change =
    row.action === "hold"
      ? "Keep"
      : row.action === "buy"
        ? `Buy ${formatUsd(row.deltaUsd)}`
        : row.action === "sell"
          ? `Sell ${formatUsd(Math.abs(row.deltaUsd))}`
          : row.action === "spend"
            ? `Spend ${formatUsd(Math.abs(row.deltaUsd))}`
            : `Keep ${formatUsd(row.deltaUsd)} more`;
  const tone = row.blocked ? "text-ink-muted line-through" : row.action === "hold" ? "text-ink-muted" : row.action === "buy" || row.action === "keep" ? "text-positive-fg" : "text-danger-fg";
  return (
    <div className={cx("grid grid-cols-[1fr_auto] md:grid-cols-[1fr_120px_120px_140px] items-center gap-x-3 gap-y-1 px-4 py-2.5 border-b border-line last:border-b-0 text-[14px]", row.blocked && "bg-surface/60")}>
      <span className="flex items-center gap-2.5 min-w-0">
        <ColorDot k={String(row.assetAddress)} />
        {cash ? <span className="inline-flex items-center justify-center h-7 w-7 rounded-[6px] border border-line font-mono text-[9px]">USDC</span> : <AssetLogo src={logo} symbol={row.symbol} size={28} />}
        <span className="min-w-0">
          <span className="block font-medium truncate">
            {cash ? "Cash" : row.symbol}
            {!row.held && !cash && <span className="ml-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">not held</span>}
          </span>
          {row.blocked && <span className="block text-[11px] text-warning-fg truncate">{row.blocked}</span>}
        </span>
      </span>
      <span className={cx("font-mono num text-[13px] text-right md:order-none order-3 col-span-2 md:col-span-1", tone)}>{change}</span>
      <span className="hidden md:block text-right font-mono num text-[12px] text-ink-secondary">
        {formatUsd(row.currentUsd)} <span className="text-ink-muted">· {bpsToPct(row.currentBps)}</span>
      </span>
      <span className="hidden md:block text-right font-mono num text-[12px] text-ink-secondary">
        {formatUsd(row.targetUsd)} <span className="text-ink-muted">· {bpsToPct(row.targetBps)}</span>
      </span>
    </div>
  );
}
