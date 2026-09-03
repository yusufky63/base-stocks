"use client";

import { useState } from "react";
import type { Allocation } from "@/domain/portfolio";
import type { AutomationDraft } from "@/lib/client-api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import type { AutomationRule } from "@/domain/community";
import type { PortfolioTemplate } from "@/domain/portfolio";
import { apiGet, apiPatch, apiPost, ApiError } from "@/lib/client-api";
import { useAuth } from "@/hooks/useAuth";
import { ErrorBanner } from "@/components/common/display";
import { useAssets } from "@/hooks/queries";
import { usePortfolioExecution } from "@/hooks/usePortfolioExecution";
import { formatUsd, timeAgo } from "@/lib/format";
import { USDC_DECIMALS } from "@/config/chain";
import { parseUnits } from "viem";
import { Module, ModuleHeader, Button, Badge, Chip } from "@/components/ui/primitives";
import { Select } from "@/components/ui/Select";
import { Slider } from "@/components/ui/Slider";
import { SignInButton } from "@/components/layout/SignInButton";
import { ExecutionProgress } from "@/components/build/ExecutionProgress";

type RuleDTO = AutomationRule & { due: boolean };

/**
 * Automation V1 (spec §4.8): the system proposes runs, the user approves each one with a wallet
 * confirmation. Nothing runs unattended.
 */
export function AutomationModule({ templates, draft = null }: { templates: PortfolioTemplate[]; draft?: AutomationDraft | null }) {
  const { address } = useAccount();
  const auth = useAuth();
  const qc = useQueryClient();
  const { data: assets } = useAssets();
  const exec = usePortfolioExecution();
  const rules = useQuery({ queryKey: ["automation", auth.signedInAs ?? ""], queryFn: async () => (await apiGet<{ rules: RuleDTO[] }>("/api/automation")).rules, enabled: auth.isSignedIn });
  const [type, setType] = useState<"recurring-buy" | "recurring-basket">("recurring-buy");
  const [asset, setAsset] = useState<string>("");
  const [templateId, setTemplateId] = useState<string>("");
  const [amount, setAmount] = useState(25);
  const [cadence, setCadence] = useState(7);
  const [running, setRunning] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [customBasket, setCustomBasket] = useState<{ name: string; allocations: Allocation[] } | null>(null);
  // A new AI draft prefills the form (render-time adjust; nothing is saved until "Save plan").
  const [seenDraft, setSeenDraft] = useState<AutomationDraft | null>(null);
  if (draft !== seenDraft) {
    setSeenDraft(draft);
    if (draft) {
      setType(draft.type);
      setAmount(Math.min(500, Math.max(5, Math.round(draft.amountUsd / 5) * 5)));
      setCadence(draft.cadenceDays);
      if (draft.type === "recurring-buy") {
        setAsset(draft.assetAddress ?? "");
        setCustomBasket(null);
      } else {
        setCustomBasket(draft.allocations ? { name: draft.basketName ?? "AI plan", allocations: draft.allocations } : null);
      }
    }
  }

  const create = useMutation({
    mutationFn: async () => {
      await auth.ensureSignedIn();
      const t = templates.find((x) => x.id === templateId);
      return apiPost("/api/automation", type === "recurring-buy" ? { type, assetAddress: asset, amountUsd: amount, cadenceDays: cadence } : { type, allocations: customBasket?.allocations ?? t?.allocations, basketName: customBasket?.name ?? t?.name, amountUsd: amount, cadenceDays: cadence });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automation"] }),
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; action: "ran" | "pause" | "resume" | "delete" }) => apiPatch("/api/automation", v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automation"] }),
  });

  const runRule = async (r: RuleDTO) => {
    if (!address) return;
    setRunning(r.id);
    setRunError(null);
    try {
      const usd = r.config.amountUsd ?? 0;
      if (r.type === "recurring-buy" && r.config.assetAddress) {
        const a = assets?.assets.find((x) => x.canonicalId === r.config.assetAddress!.toLowerCase());
        await exec.startLegs([{ side: "buy", assetAddress: r.config.assetAddress as Address, symbol: a?.symbol ?? "", targetUsd: usd, amount: parseUnits(usd.toFixed(USDC_DECIMALS), USDC_DECIMALS) }]);
      } else if (r.type === "recurring-basket" && r.config.allocations) {
        const legs = r.config.allocations
          .filter((al) => al.assetAddress !== "USDC" && BigInt(assets?.assets.find((x) => x.canonicalId === (al.assetAddress as string).toLowerCase())?.totalSupply ?? "1") > 0n)
          .map((al) => {
            const a = assets?.assets.find((x) => x.canonicalId === (al.assetAddress as string).toLowerCase());
            const legUsd = (usd * al.weightBps) / 10_000;
            return { side: "buy" as const, assetAddress: al.assetAddress as Address, symbol: a?.symbol ?? "", targetUsd: legUsd, amount: parseUnits(legUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS) };
          })
          .filter((l) => l.targetUsd >= 1);
        await exec.startLegs(legs);
      }
      await patch.mutateAsync({ id: r.id, action: "ran" });
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "The run could not be prepared. Nothing was sent.");
    } finally {
      setRunning(null);
    }
  };

  const assetOptions = (assets?.assets ?? []).filter((a) => a.status === "active" && BigInt(a.totalSupply ?? "0") > 0n).map((a) => ({ value: a.address as string, label: `${a.underlying} — ${a.name}` }));
  const templateOptions = templates.map((t) => ({ value: t.id, label: t.name }));

  return (
    <Module>
      <ModuleHeader index="A" title="Your plans" action={<Badge>you confirm every run</Badge>} />
      {!auth.isSignedIn ? (
        <div className="p-4 flex flex-col gap-2">
          <p className="text-[13px] text-ink-secondary">Recurring buys and basket plans are stored per wallet and executed only when you approve each run.</p>
          <SignInButton label="Sign in to manage plans" />
        </div>
      ) : (
        <>
          {exec.execution && exec.summary && (
            <div className="p-4 border-b border-line">
              <ExecutionProgress execution={exec.execution} currentStepId={exec.currentStepId} running={exec.running} summary={exec.summary} onRetry={() => exec.retry()} onClose={() => exec.reset()} verb="buys" />
            </div>
          )}
          {runError && (
            <div className="px-4 pt-3">
              <ErrorBanner message={runError} />
            </div>
          )}
          {(rules.data ?? []).map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-3 px-4 py-3 border-b border-line">
              <div className="min-w-0">
                <div className="font-medium text-[14px]">
                  {r.type === "recurring-buy" ? `Buy ${formatUsd(r.config.amountUsd)} of ${assets?.assets.find((x) => x.canonicalId === r.config.assetAddress?.toLowerCase())?.underlying ?? "stock"}` : `Invest ${formatUsd(r.config.amountUsd)} in ${r.config.basketName ?? "basket"}`}
                  <span className="text-ink-secondary font-normal"> · every {r.config.cadenceDays} days</span>
                </div>
                <div className="text-[12px] text-ink-muted font-mono">
                  {r.status}
                  {r.nextRunAt ? ` · next ${r.due ? "due now" : new Date(r.nextRunAt).toLocaleDateString()}` : ""}
                  {r.lastRunAt ? ` · last ${timeAgo(r.lastRunAt)}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {r.status === "active" && (
                  <Button size="sm" variant={r.due ? "primary" : "secondary"} loading={running === r.id} disabled={exec.running} onClick={() => runRule(r)}>
                    {r.due ? "Run now" : "Run early"}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => patch.mutate({ id: r.id, action: r.status === "active" ? "pause" : "resume" })}>
                  {r.status === "active" ? "Pause" : "Resume"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => patch.mutate({ id: r.id, action: "delete" })}>
                  Delete
                </Button>
              </div>
            </div>
          ))}
          <div className="p-4 flex flex-col gap-3">
            <div className="eyebrow">New plan</div>
            <div className="flex gap-2">
              <Chip active={type === "recurring-buy"} onClick={() => setType("recurring-buy")}>
                Single stock
              </Chip>
              <Chip active={type === "recurring-basket"} onClick={() => setType("recurring-basket")}>
                Template basket
              </Chip>
            </div>
            {type === "recurring-buy" ? (
              <Select value={asset} onChange={setAsset} options={assetOptions} ariaLabel="Stock" placeholder="Pick a stock…" />
            ) : customBasket ? (
              <div className="flex items-center justify-between gap-2 text-[13px] border border-line rounded-[6px] px-3 h-11">
                <span className="truncate">
                  AI plan: <span className="font-medium">{customBasket.name}</span> · {customBasket.allocations.length} parts
                </span>
                <button type="button" className="text-primary font-medium shrink-0" onClick={() => setCustomBasket(null)}>
                  Use a template
                </button>
              </div>
            ) : (
              <Select value={templateId} onChange={setTemplateId} options={templateOptions} ariaLabel="Template" placeholder="Pick a template…" />
            )}
            <Slider value={amount} min={5} max={500} step={5} onChange={setAmount} ariaLabel="Amount per run" valueLabel={formatUsd(amount)} marks={["$5", "$250", "$500"]} />
            <div className="flex gap-2">
              {[1, 7, 14, 30].map((d) => (
                <Chip key={d} active={cadence === d} onClick={() => setCadence(d)}>
                  {d === 1 ? "Daily" : d === 7 ? "Weekly" : d === 14 ? "Biweekly" : "Monthly"}
                </Chip>
              ))}
            </div>
            <Button size="sm" loading={create.isPending} disabled={type === "recurring-buy" ? !asset : !templateId && !customBasket} onClick={() => create.mutate()}>
              Save plan
            </Button>
            {create.error && <span className="text-[13px] text-danger-fg">{create.error instanceof ApiError ? create.error.message : "Could not save."}</span>}
            <p className="text-[12px] text-ink-muted">Plans never move funds by themselves: when a run is due you confirm it in your wallet.</p>
          </div>
        </>
      )}
    </Module>
  );
}
