"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Pause, Play, Trash2, Zap } from "lucide-react";
import type { AutomationRunRecord } from "@/domain/community";
import { TOTAL_BPS, USDC_ALLOCATION_KEY } from "@/domain/portfolio";
import { apiPatch, type AutomationRuleDTO } from "@/lib/client-api";
import { useAssets } from "@/hooks/queries";
import { useAutomation } from "@/hooks/useAutomation";
import { useAutoInvest } from "@/hooks/useAutoInvest";
import { useNow } from "@/hooks/useNow";
import type { ManualRun } from "@/hooks/useManualRun";
import { CADENCES, cadenceLabel, usdcToUsd } from "@/lib/auto-invest";
import { formatUsd, timeAgo, timeUntil } from "@/lib/format";
import { BASE_EXPLORER_URL, MIN_TRADE_USD } from "@/config/chain";
import { AssetLogo, ErrorBanner, InfoBanner, TxLink } from "@/components/common/display";
import { Button, Badge, KeyValue, cx } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/Segmented";
import { Sheet } from "@/components/ui/Sheet";
import { ExecutionProgress } from "@/components/build/ExecutionProgress";

const RUN_PRESETS = [4, 12, 26, 52] as const;

/**
 * Everything about one plan, in one place: run it, pause or resume it, change its terms, keep it
 * funded, cancel it, and read what it did. Auto plans act through the wallet (each button is one
 * signature); manual plans act through the app. The sheet stays open while a wallet action is in
 * flight so the outcome lands where the click was.
 */
export function PlanManageSheet({ rule, open, onClose, manual }: { rule: AutomationRuleDTO; open: boolean; onClose: () => void; manual: ManualRun }) {
  const automation = useAutomation();
  const autoInvest = useAutoInvest();
  const { data: assets } = useAssets();
  const now = useNow();
  const auto = rule.config.mode === "auto";
  const onchain = rule.config.onchain;
  const funding = onchain?.funding;
  const expired = !!rule.config.expiryAt && now > 0 && rule.config.expiryAt < now;
  const cancelled = rule.status === "cancelled";
  const allocations = rule.config.allocations ?? (rule.config.assetAddress ? [{ assetAddress: rule.config.assetAddress, weightBps: TOTAL_BPS }] : []);
  const stocks = allocations.filter((a) => a.assetAddress !== USDC_ALLOCATION_KEY);
  const logoOf = (address: string) => assets?.assets.find((a) => a.canonicalId === address.toLowerCase());
  const title = rule.type === "recurring-buy" ? (logoOf(rule.config.assetAddress ?? "")?.underlying ?? "stock") : (rule.config.basketName ?? "basket");
  const busy = autoInvest.busy || manual.running || manual.preparing === rule.id;

  const patch = useMutation({
    mutationFn: (v: { id: string; action: "pause" | "resume" | "delete" | "terms"; amountUsd?: number; cadenceDays?: number }) => apiPatch("/api/automation", v),
    onSuccess: () => automation.invalidate(),
  });

  // Terms editor
  const [amount, setAmount] = useState(rule.config.amountUsd ?? 25);
  const [cadence, setCadence] = useState(rule.config.cadenceDays ?? 7);
  const smallestBps = stocks.reduce((m, a) => Math.min(m, a.weightBps), TOTAL_BPS);
  const amountForAllLegs = Math.ceil((MIN_TRADE_USD * TOTAL_BPS) / smallestBps);
  const termsChanged = amount !== (rule.config.amountUsd ?? 25) || cadence !== (rule.config.cadenceDays ?? 7);

  // Funding
  const [runs, setRuns] = useState<number>(12);
  const perRun = rule.config.amountUsd ?? 0;

  const saveTerms = async () => {
    if (auto && onchain) await autoInvest.updatePlan(rule.id, onchain.planId, { amountUsd: amount, cadenceDays: cadence, expiryAt: rule.config.expiryAt ?? null, maxSlippageBps: rule.config.maxSlippageBps ?? onchain.maxSlippageBps });
    else await patch.mutateAsync({ id: rule.id, action: "terms", amountUsd: amount, cadenceDays: cadence });
  };

  const locked = autoInvest.busy || manual.running;

  return (
    <Sheet open={open} onClose={onClose} locked={locked} wide title={`${formatUsd(rule.config.amountUsd)} · ${title}`} footer={
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-ink-muted">{auto ? "Every change here is one wallet signature." : "Changes apply at once; runs still wait for your wallet."}</span>
        <Button variant="secondary" size="sm" disabled={locked} onClick={onClose}>
          Close
        </Button>
      </div>
    }>
      <div className="flex flex-col gap-5">
        {/* What and when */}
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="flex -space-x-2">
              {stocks.slice(0, 5).map((a) => {
                const info = logoOf(a.assetAddress as string);
                return <AssetLogo key={a.assetAddress} src={info?.logoURI} symbol={info?.symbol ?? "?"} size={28} className="ring-2 ring-canvas rounded-full" />;
              })}
            </span>
            {auto ? <Badge tone="primary">automatic</Badge> : <Badge>you confirm</Badge>}
            {cancelled ? <Badge>cancelled</Badge> : expired ? <Badge>expired</Badge> : rule.status === "paused" ? <Badge tone="warning">paused</Badge> : rule.due ? <Badge tone="positive">due now</Badge> : <Badge tone="positive">active</Badge>}
            <span className="text-[12px] text-ink-secondary">{cadenceLabel(rule.config.cadenceDays ?? 7)}</span>
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] font-mono text-ink-secondary">
            {stocks.map((a) => (
              <li key={a.assetAddress}>
                {logoOf(a.assetAddress as string)?.underlying ?? (a.assetAddress as string).slice(0, 6)} {(a.weightBps / 100).toFixed(0)}% · {formatUsd(((rule.config.amountUsd ?? 0) * a.weightBps) / TOTAL_BPS)}
              </li>
            ))}
          </ul>
          <div>
            <KeyValue k="Next run" v={cancelled ? "—" : expired ? "expired" : rule.due ? `due since ${new Date(rule.nextRunAt!).toLocaleDateString()}${rule.missed > 1 ? ` · ${rule.missed} runs went by` : ""}` : rule.nextRunAt ? new Date(rule.nextRunAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—"} mono={false} />
            <KeyValue k="Last run" v={rule.lastRunAt ? timeAgo(rule.lastRunAt) : "never"} mono={false} />
            {onchain && <KeyValue k="Runs so far" v={String(onchain.runs)} />}
            {rule.config.expiryAt && <KeyValue k="Ends" v={new Date(rule.config.expiryAt).toLocaleDateString()} mono={false} />}
            {onchain && (
              <KeyValue
                k="Onchain"
                v={
                  <a href={`${BASE_EXPLORER_URL}/address/${onchain.contract}`} target="_blank" rel="noopener noreferrer" className="text-primary">
                    plan #{onchain.planId} · {onchain.contract.slice(0, 6)}…{onchain.contract.slice(-4)}
                  </a>
                }
              />
            )}
          </div>
        </section>

        {(manual.error || autoInvest.error) && <ErrorBanner message={manual.error ?? autoInvest.error ?? ""} />}
        {manual.notice && <InfoBanner>{manual.notice}</InfoBanner>}
        {rule.config.towardTarget && <p className="text-[12px] text-ink-secondary">This plan buys toward your saved target: each run reads the holdings of the day, buys only what is under target, up to {formatUsd(rule.config.amountUsd)}, and never sells.</p>}
        {manual.execution && manual.summary && <ExecutionProgress execution={manual.execution} currentStepId={manual.currentStepId} running={manual.running} summary={manual.summary} onRetry={() => manual.retry()} onClose={() => manual.reset()} verb="buys" />}

        {/* Run */}
        {!cancelled && !expired && rule.status === "active" && (
          <section className="flex flex-col gap-2 border border-line rounded-[8px] p-3">
            <div className="eyebrow">Run</div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant={rule.due ? "primary" : "secondary"} loading={manual.preparing === rule.id} disabled={busy || (auto && !rule.due)} onClick={() => (auto ? void autoInvest.runNow(rule.id) : void manual.run(rule))}>
                {auto && <Zap size={13} strokeWidth={1.75} />}
                {rule.due ? "Run now" : auto ? "Not due yet" : "Run early"}
              </Button>
              <span className="text-[12px] text-ink-secondary">
                {auto ? (rule.due ? "Sends execute from your wallet; the keeper would do the same on its next tick." : "The contract refuses a run before the date above; the keeper picks it up when it is due.") : "Each leg gets a fresh quote and a wallet confirmation; the plan advances only if something is bought."}
              </span>
            </div>
            {auto && funding && !funding.enough && (
              <div className="text-[12px] text-warning-fg inline-flex items-start gap-1.5">
                <AlertTriangle size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" />
                <span>{BigInt(funding.usdcBalance) < BigInt(onchain!.amountPerRun) ? `Not enough USDC for a run (${formatUsd(usdcToUsd(funding.usdcBalance))} in the wallet).` : "The USDC allowance no longer covers a run; approve more below."}</span>
              </div>
            )}
            {rule.config.lastError && (
              <div className="text-[12px] text-warning-fg inline-flex items-start gap-1.5">
                <AlertTriangle size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" />
                <span>
                  {rule.config.lastError.message}
                  {rule.config.lastError.retryAt && rule.config.lastError.retryAt > now ? ` Keeper retries ${timeUntil(rule.config.lastError.retryAt, now)}.` : ""}
                </span>
              </div>
            )}
          </section>
        )}

        {/* Terms */}
        {!cancelled && (
          <section className="flex flex-col gap-3 border border-line rounded-[8px] p-3">
            <div className="eyebrow">Terms</div>
            <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-x-4 gap-y-2 items-center">
              <span className="text-[12px] text-ink-secondary">Amount per run</span>
              <div className="flex items-center gap-2">
                <span className="text-ink-secondary">$</span>
                <input type="number" min={MIN_TRADE_USD} max={1000} step="any" value={amount} onChange={(e) => setAmount(Math.max(MIN_TRADE_USD, Math.min(1000, Number(e.target.value) || MIN_TRADE_USD)))} className="w-28 h-9 rounded-[6px] border border-line-strong bg-canvas px-2 num text-right" aria-label="Amount per run" />
              </div>
              <span className="text-[12px] text-ink-secondary">Cadence</span>
              <Segmented size="sm" ariaLabel="Cadence" value={cadence} onChange={setCadence} options={CADENCES.map((c) => ({ value: c.days, label: c.label }))} />
            </div>
            {amount < amountForAllLegs && (
              <p className="text-[12px] text-warning-fg">
                Below {formatUsd(amountForAllLegs)} the smallest leg ({(smallestBps / 100).toFixed(0)}%) is under the {formatUsd(MIN_TRADE_USD)} per-leg minimum and is skipped every run.{" "}
                <button type="button" className="font-medium text-primary" onClick={() => setAmount(amountForAllLegs)}>
                  Use {formatUsd(amountForAllLegs)}
                </button>
              </p>
            )}
            <div className="flex items-center gap-2">
              <Button size="sm" loading={auto ? autoInvest.busy : patch.isPending} disabled={!termsChanged || busy} onClick={() => void saveTerms()}>
                {auto ? "Save onchain" : "Save"}
              </Button>
              <span className="text-[12px] text-ink-muted">The stocks and their weights stay as they are; a different mix is a new plan.</span>
            </div>
          </section>
        )}

        {/* Funding (auto only) */}
        {auto && onchain && !cancelled && (
          <section className="flex flex-col gap-3 border border-line rounded-[8px] p-3">
            <div className="eyebrow">Funding</div>
            {funding ? (
              <div>
                <KeyValue k="USDC in the wallet" v={formatUsd(usdcToUsd(funding.usdcBalance))} />
                <KeyValue k="Allowance left" v={`${formatUsd(usdcToUsd(funding.allowance))} · ${funding.runsCovered} run${funding.runsCovered === 1 ? "" : "s"}`} />
              </div>
            ) : (
              <p className="text-[12px] text-ink-secondary">Funding is read from the chain on each visit.</p>
            )}
            <div className="flex flex-col gap-2">
              <span className="text-[12px] text-ink-secondary">Approve USDC for more runs</span>
              <Segmented size="sm" ariaLabel="Runs to approve" value={runs} onChange={setRuns} options={RUN_PRESETS.map((n) => ({ value: n, label: `${n} runs` }))} />
              <div className="flex items-center gap-2 flex-wrap">
                <Button size="sm" variant="secondary" loading={autoInvest.busy} disabled={busy} onClick={() => void autoInvest.setAllowance(runs * perRun, rule.id)}>
                  Approve {formatUsd(runs * perRun)}
                </Button>
                <Button size="sm" variant="danger" disabled={busy || !funding || BigInt(funding.allowance) === 0n} onClick={() => window.confirm("Revoke the USDC allowance? No auto plan can draw USDC until you approve again.") && void autoInvest.setAllowance(0, rule.id)}>
                  Revoke USDC
                </Button>
                <span className="text-[12px] text-ink-muted">A normal ERC-20 allowance to the contract; revoking it stops every plan at once, whatever any server thinks.</span>
              </div>
            </div>
          </section>
        )}

        {/* Status */}
        <section className="flex flex-col gap-2 border border-line rounded-[8px] p-3">
          <div className="eyebrow">Status</div>
          <div className="flex items-center gap-2 flex-wrap">
            {!cancelled && (
              <Button size="sm" variant="secondary" disabled={busy} loading={patch.isPending && !auto} onClick={() => (auto && onchain ? void autoInvest.setActive(rule.id, onchain.planId, rule.status !== "active") : patch.mutate({ id: rule.id, action: rule.status === "active" ? "pause" : "resume" }))}>
                {rule.status === "active" ? <Pause size={13} strokeWidth={1.75} /> : <Play size={13} strokeWidth={1.75} />}
                {rule.status === "active" ? "Pause" : "Resume"}
              </Button>
            )}
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => {
                if (auto && onchain && !cancelled) {
                  if (window.confirm("Cancel this plan onchain? It cannot be resumed; you can always start a new one.")) void autoInvest.cancelPlan(rule.id, onchain.planId);
                } else if (window.confirm("Remove this plan from the list?")) {
                  patch.mutate({ id: rule.id, action: "delete" });
                  onClose();
                }
              }}
            >
              <Trash2 size={13} strokeWidth={1.75} /> {auto && !cancelled ? "Cancel plan" : "Remove"}
            </Button>
            <span className="text-[12px] text-ink-muted">{auto ? "Pausing keeps the plan; cancelling is final. A paused plan owes exactly one run when resumed." : "Pausing stops proposals; removing deletes the plan."}</span>
          </div>
        </section>

        {/* History */}
        <section className="flex flex-col gap-2">
          <div className="eyebrow">Runs</div>
          {(rule.config.history ?? []).length === 0 ? <p className="text-[12px] text-ink-secondary">No runs yet.</p> : <History items={rule.config.history ?? []} />}
        </section>
      </div>
    </Sheet>
  );
}

function History({ items }: { items: AutomationRunRecord[] }) {
  return (
    <ul className="border border-line rounded-[8px] overflow-hidden">
      {items.slice(0, 20).map((h, i) => (
        <li key={`${h.at}-${i}`} className="px-3 py-2 border-b border-line last:border-b-0 text-[12px] flex flex-col gap-0.5">
          <span className="flex items-center gap-2 flex-wrap">
            <span className={cx("font-mono", h.ok ? "text-positive-fg" : "text-danger-fg")}>{h.ok ? (h.note ? "in balance" : "bought") : "failed"}</span>
            <span className="text-ink-secondary">{new Date(h.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
            {h.spentUsd !== undefined && h.spentUsd > 0 && <span className="font-mono num">{formatUsd(h.spentUsd)}</span>}
            <span className="text-ink-muted">via {h.via === "keeper" ? "keeper" : "your wallet"}</span>
            {h.txHash && <TxLink hash={h.txHash} />}
          </span>
          {h.legs && h.legs.length > 0 && (
            <span className="text-ink-secondary">{h.legs.map((l) => `${(l.symbol ?? l.assetAddress.slice(0, 6)).replace(/c$/, "")}${l.skipped ? ` skipped (${l.skipped})` : ` ${formatUsd(l.spentUsd)}`}`).join(" · ")}</span>
          )}
          {h.error && <span className="text-warning-fg">{h.error}</span>}
          {h.note && <span className="text-ink-muted">{h.note}</span>}
        </li>
      ))}
    </ul>
  );
}

export function fundingNote(rule: AutomationRuleDTO): string | null {
  const f = rule.config.onchain?.funding;
  if (!f || rule.status !== "active") return null;
  if (f.enough) return null;
  return BigInt(f.usdcBalance) < BigInt(rule.config.onchain!.amountPerRun) ? "Top up USDC" : "Approve more USDC";
}
