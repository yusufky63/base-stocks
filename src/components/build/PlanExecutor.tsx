"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { formatUnits } from "viem";
import type { Allocation, DeferredPolicy, PortfolioPlan } from "@/domain/portfolio";
import { apiPost, ApiError, type PlanResponse } from "@/lib/client-api";
import { usePortfolioExecution } from "@/hooks/usePortfolioExecution";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { qk } from "@/hooks/queries";
import { USDC_ADDRESS, USDC_DECIMALS } from "@/config/chain";
import { formatTokenAmount, formatUsd, bpsToPct } from "@/lib/format";
import { parseAmountSafe } from "@/lib/b20/math";
import { runnableLegs } from "@/lib/execution/portfolio-execution";
import { AmountInput } from "@/components/ui/Input";
import { Button, Chip, KeyValue } from "@/components/ui/primitives";
import { Slider } from "@/components/ui/Slider";
import { ConnectButton } from "@/components/layout/ConnectButton";
import { ErrorBanner, InfoBanner } from "@/components/common/display";
import { ExecutionProgress } from "./ExecutionProgress";

const CHIPS = [100, 250, 500, 1000];

interface Props {
  allocations: Allocation[];
  source: "template" | "custom" | "ai" | "community";
  disabled?: boolean;
  onComplete?: () => void;
  /** Fires when legs start or stop executing, so the editor above can lock itself meanwhile. */
  onExecutingChange?: (executing: boolean) => void;
}

/**
 * Amount → server-validated plan with per-leg executable quotes → review → sequential execution
 * with honest partial-fill state and per-leg retry (spec §4.4, §25).
 *
 * The component survives edits to the basket: a changed allocation drops the stale preview and
 * keeps the amount typed in, instead of remounting and forgetting everything, including a run in
 * progress.
 */
export function PlanExecutor({ allocations, source, disabled, onComplete, onExecutingChange }: Props) {
  const { address, isConnected } = useAccount();
  const qc = useQueryClient();
  const balances = useTokenBalances(address, USDC_ADDRESS);
  const [amount, setAmount] = useState("250");
  const [plan, setPlan] = useState<PortfolioPlan | null>(null);
  const [planErrors, setPlanErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [deferredPolicy, setDeferredPolicy] = useState<DeferredPolicy>("reserve");
  const exec = usePortfolioExecution();

  // A preview belongs to the basket it was quoted for; when the basket changes the preview goes.
  const allocationKey = JSON.stringify(allocations);
  const previewedFor = useRef(allocationKey);
  useEffect(() => {
    if (previewedFor.current !== allocationKey) {
      previewedFor.current = allocationKey;
      setPlan(null);
      setPlanErrors([]);
    }
  }, [allocationKey]);

  useEffect(() => {
    onExecutingChange?.(!!exec.execution);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!exec.execution]);

  useEffect(() => {
    if (exec.execution?.status === "COMPLETE") {
      qc.invalidateQueries({ queryKey: qk.portfolio(address ?? "") });
      qc.invalidateQueries({ queryKey: qk.activity(address ?? "") });
      onComplete?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exec.execution?.status]);

  const totalUsd = Number(amount || 0);
  const usdcBalanceUsd = Number(formatUnits(balances.usdc, USDC_DECIMALS));
  const usdcRaw = parseAmountSafe(amount, USDC_DECIMALS);
  const sliderMax = isConnected && usdcBalanceUsd > 1 ? Math.floor(usdcBalanceUsd) : 2000;
  // What actually leaves the wallet is the live legs, not the headline amount: cash kept as USDC
  // and deferred names stay put, so they are not held against the balance.
  const runnable = plan ? runnableLegs(plan) : [];
  const spendUsd = runnable.reduce((s, l) => s + l.targetUsd, 0);
  const insufficient = isConnected && (plan ? spendUsd : totalUsd) > usdcBalanceUsd;

  const preview = async (policy: DeferredPolicy = deferredPolicy) => {
    setLoading(true);
    setPlanErrors([]);
    try {
      const res = await apiPost<PlanResponse>("/api/portfolio/plan", { allocations, totalUsd, taker: address, quote: true, source, deferredPolicy: policy });
      if (!res.ok || !res.plan) setPlanErrors(res.errors ?? ["Plan could not be built."]);
      else setPlan(res.plan);
    } catch (err) {
      setPlanErrors([err instanceof ApiError ? err.message : "Plan could not be built."]);
    } finally {
      setLoading(false);
    }
  };

  const execution = exec.execution;
  const summary = exec.summary;

  return (
    <div className="flex flex-col gap-4">
      {!execution && (
        <>
          <AmountInput value={amount} onChange={setAmount} unit="USD" ariaLabel="Total amount to invest in US dollars" />
          <Slider value={Math.min(sliderMax, Math.max(0, totalUsd))} min={0} max={sliderMax} step={sliderMax > 500 ? 5 : 1} onChange={(v) => setAmount(String(v))} ariaLabel="Amount slider" marks={["$0", formatUsd(sliderMax / 2), isConnected && usdcBalanceUsd > 1 ? "Balance" : formatUsd(sliderMax)]} />
          <div className="grid grid-cols-5 gap-1.5">
            {CHIPS.map((v) => (
              <Chip key={v} className="w-full px-0" active={amount === String(v)} onClick={() => setAmount(String(v))}>
                ${v}
              </Chip>
            ))}
            <Chip className="w-full px-0" active={!CHIPS.includes(Number(amount))} onClick={() => setAmount("")}>
              Custom
            </Chip>
          </div>
          <div className="flex items-center justify-between text-[13px] text-ink-secondary">
            <span>USDC balance</span>
            <span className="font-mono num">{isConnected ? formatUsd(usdcBalanceUsd) : "—"}</span>
          </div>
          {insufficient && <p className="text-[13px] text-danger-fg">You don’t have enough USDC for {plan ? "these purchases" : "this amount"}.</p>}
          {planErrors.map((e) => (
            <ErrorBanner key={e} message={e} />
          ))}
          {!plan ? (
            <Button size="lg" full loading={loading} disabled={disabled || usdcRaw === 0n || allocations.length === 0} onClick={() => preview()}>
              Preview with live quotes
            </Button>
          ) : (
            <PlanPreview
              plan={plan}
              policy={deferredPolicy}
              onPolicy={(p) => {
                setDeferredPolicy(p);
                void preview(p);
              }}
            />
          )}
          {plan && (
            <div className="flex gap-2">
              <Button variant="secondary" full onClick={() => setPlan(null)}>
                Edit
              </Button>
              {!isConnected ? (
                <ConnectButton full />
              ) : (
                <Button full size="lg" disabled={insufficient || runnable.length === 0} onClick={() => exec.start(plan)}>
                  Buy {runnable.length} {runnable.length === 1 ? "stock" : "stocks"} for {formatUsd(spendUsd)}
                </Button>
              )}
            </div>
          )}
        </>
      )}

      {execution && summary && <ExecutionProgress execution={execution} currentStepId={exec.currentStepId} running={exec.running} summary={summary} onRetry={() => exec.retry()} onClose={() => exec.reset()} />}
    </div>
  );
}

function PlanPreview({ plan, policy, onPolicy }: { plan: PortfolioPlan; policy: DeferredPolicy; onPolicy: (p: DeferredPolicy) => void }) {
  const deferred = plan.deferred ?? [];
  const unquoted = plan.legs.filter((l) => l.quoteError);
  return (
    <div className="flex flex-col gap-3">
      <div className="border border-line rounded-[8px] overflow-hidden">
        <div className="grid grid-cols-[1fr_70px_90px_1fr] px-3 py-2 border-b border-line font-mono text-[11px] uppercase tracking-[0.12em] text-ink-muted">
          <span>Stock</span>
          <span className="text-right">Weight</span>
          <span className="text-right">Amount</span>
          <span className="text-right">Est. shares</span>
        </div>
        {plan.legs.map((l) => (
          <div key={l.assetAddress} className={`grid grid-cols-[1fr_70px_90px_1fr] px-3 py-2 border-b border-line last:border-b-0 text-[14px] items-center ${l.quoteError ? "bg-surface/60" : ""}`}>
            <span className="font-medium">
              {l.symbol.replace(/c$/, "")}
              {l.quoteError && <span className="ml-1 font-mono text-[10px] uppercase tracking-[0.08em] text-warning-fg">no quote</span>}
            </span>
            <span className="text-right font-mono num text-[13px]">{bpsToPct(l.weightBps)}</span>
            <span className="text-right font-mono num text-[13px]">{formatUsd(l.targetUsd)}</span>
            <span className="text-right font-mono num text-[13px]">{l.quoteError ? <span className="text-[12px] text-ink-secondary">skipped · stays as USDC</span> : l.estimatedBuyAmount ? formatTokenAmount(l.estimatedBuyAmount, 8) : "—"}</span>
          </div>
        ))}
        {deferred.map((d) => (
          <div key={`deferred-${d.assetAddress}`} className="grid grid-cols-[1fr_70px_90px_1fr] px-3 py-2 border-b border-line last:border-b-0 text-[14px] items-center bg-surface/60">
            <span className="font-medium text-ink-secondary min-w-0">
              {d.symbol.replace(/c$/, "")} <span className="ml-1 font-mono text-[10px] uppercase tracking-[0.08em] text-warning-fg">{deferredTag(d.reason)}</span>
            </span>
            <span className="text-right font-mono num text-[13px] text-ink-muted">{bpsToPct(d.weightBps)}</span>
            <span className="text-right font-mono num text-[13px] text-ink-muted">{plan.deferredPolicy === "redistribute" ? "—" : formatUsd(d.targetUsd)}</span>
            <span className="text-right text-[12px] text-ink-secondary">{plan.deferredPolicy === "redistribute" ? "spread across live stocks" : "kept as USDC"}</span>
          </div>
        ))}
      </div>
      {deferred.length > 0 && (
        <div className="flex items-center justify-between gap-2 flex-wrap text-[13px]">
          <span className="text-ink-secondary">Money for stocks that cannot be bought today</span>
          <div className="flex gap-1.5">
            <Chip active={policy === "reserve"} onClick={() => onPolicy("reserve")}>
              Keep as USDC
            </Chip>
            <Chip active={policy === "redistribute"} onClick={() => onPolicy("redistribute")}>
              Spread across live stocks
            </Chip>
          </div>
        </div>
      )}
      {plan.keepUsdcUsd > 0 && <KeyValue k="Kept as USDC cash" v={`${formatUsd(plan.keepUsdcUsd)} (${bpsToPct(plan.keepUsdcBps)})`} />}
      <KeyValue k="Execution" v={`${plan.legs.length - unquoted.length} separate purchases, confirmed one by one`} mono={false} />
      {unquoted.length > 0 && (
        <InfoBanner tone="warning">
          {unquoted.map((l) => `${l.symbol.replace(/c$/, "")}: ${l.quoteError}`).join(" · ")}. {unquoted.length === 1 ? "That leg is" : "Those legs are"} left out rather than queued to fail; the money stays as USDC.
        </InfoBanner>
      )}
      {plan.warnings.map((w) => (
        <InfoBanner key={w} tone="warning">
          {w}
        </InfoBanner>
      ))}
      <p className="text-[12px] text-ink-muted">Quotes are indicative; each leg gets a fresh executable quote when you confirm it. Legs are not atomic: if one fails, completed legs stay in your wallet and you can retry the rest.</p>
    </div>
  );
}

/** Short tag for a deferral reason; the full sentence is in the warning below the table. */
function deferredTag(reason: string): string {
  if (/not issued/i.test(reason)) return "not issued";
  if (/no pool/i.test(reason)) return "no pool";
  if (/paused/i.test(reason)) return "paused";
  if (/% of its pool/i.test(reason)) return "too thin";
  return "skipped";
}
