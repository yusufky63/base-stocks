"use client";

import { useState } from "react";
import { Sparkles, Wand2 } from "lucide-react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { apiPost, ApiError, type AutomationDraft } from "@/lib/client-api";
import { useAssets } from "@/hooks/queries";
import { CADENCES, cadenceNoun } from "@/lib/auto-invest";
import { formatUsd } from "@/lib/format";
import { MIN_TRADE_USD } from "@/config/chain";
import { AssetLogo, AiQuotaNote, ErrorBanner } from "@/components/common/display";
import { Button, cx } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/Segmented";

type Resp = { ok: boolean; draft?: AutomationDraft; errors?: string[]; warnings?: string[]; quota?: { remainingForWallet: number } };

const AMOUNTS = [10, 25, 50, 100] as const;
const MAX_AMOUNT = 1000;
const CASH = [0, 10, 20] as const;
type AmountChoice = (typeof AMOUNTS)[number] | "custom";

/**
 * Plan drafting in two lanes. Guided: amount, cadence, stocks and cash, and the plan is built
 * deterministically without a model call. Free text: one sentence goes to the assistant, which
 * only knows live tickers. Either way the result fills the New plan form; saving and every run
 * stay yours.
 */
export function AiRuleDraft({ onDraft }: { onDraft: (draft: AutomationDraft) => void }) {
  const { address } = useAccount();
  const { data: assets } = useAssets();
  const live = (assets?.assets ?? []).filter((a) => a.status === "active" && BigInt(a.totalSupply ?? "0") > 0n);
  const [amount, setAmount] = useState<number>(25);
  const [amountChoice, setAmountChoice] = useState<AmountChoice>(25);
  const [cadence, setCadence] = useState<number>(7);
  const [picked, setPicked] = useState<string[]>([]);
  const [cash, setCash] = useState<number>(0);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  const chooseAmount = (usd: number) => {
    setAmount(usd);
    setAmountChoice((AMOUNTS as readonly number[]).includes(usd) ? (usd as AmountChoice) : "custom");
  };
  const chosen = live.filter((a) => picked.includes(a.underlying));
  const stockBps = 10_000 - cash * 100;
  const perStock = chosen.length > 0 ? (amount * stockBps) / 10_000 / chosen.length : 0;
  const summary =
    chosen.length === 0
      ? "Pick at least one stock to see the plan."
      : chosen.length === 1 && cash === 0
        ? `Buy ${formatUsd(amount)} of ${chosen[0]!.underlying} every ${cadenceNoun(cadence)}.`
        : `Invest ${formatUsd(amount)} every ${cadenceNoun(cadence)}: ${chosen.map((a) => a.underlying).join(", ")} at ${formatUsd(perStock)} each${cash ? `, ${cash}% kept as USDC` : ""}.`;
  const tooSmall = chosen.length > 0 && perStock > 0 && perStock < MIN_TRADE_USD;

  const applyGuided = () => {
    setErrors([]);
    if (chosen.length === 0) {
      setErrors(["Pick at least one live stock."]);
      return;
    }
    if (chosen.length === 1 && cash === 0) {
      const a = chosen[0]!;
      const draft: AutomationDraft = { type: "recurring-buy", assetAddress: a.address as Address, symbol: a.underlying, amountUsd: amount, cadenceDays: cadence, notes: summary };
      onDraft(draft);
      setNotes(draft.notes);
      return;
    }
    const each = Math.floor(stockBps / chosen.length);
    const allocations = chosen.map((a, i) => ({ assetAddress: a.address as Address, weightBps: each + (i === 0 ? stockBps - each * chosen.length : 0) }));
    if (cash > 0) allocations.push({ assetAddress: "USDC" as unknown as Address, weightBps: cash * 100 });
    const draft: AutomationDraft = { type: "recurring-basket", basketName: `${chosen.map((a) => a.underlying).join(" + ")}${cash ? ` + ${cash}% USDC` : ""}`, allocations, amountUsd: amount, cadenceDays: cadence, notes: summary };
    onDraft(draft);
    setNotes(draft.notes);
  };

  const submitAi = async () => {
    const p = prompt.trim();
    if (p.length < 3 || loading) return;
    setLoading(true);
    setErrors([]);
    setNotes(null);
    try {
      const res = await apiPost<Resp>("/api/automation/intent", { prompt: p, owner: address });
      if (res.quota) setRemaining(res.quota.remainingForWallet);
      if (!res.ok || !res.draft) {
        setErrors(res.errors ?? ["No plan could be drafted."]);
        return;
      }
      onDraft(res.draft);
      setNotes([res.draft.notes, ...(res.warnings ?? [])].filter(Boolean).join(" "));
    } catch (err) {
      setErrors([err instanceof ApiError ? err.message : "AI assistance is unavailable right now."]);
      const quota = err instanceof ApiError ? (err.body?.quota as { remainingForWallet?: number } | undefined) : undefined;
      if (typeof quota?.remainingForWallet === "number") setRemaining(quota.remainingForWallet);
    } finally {
      setLoading(false);
    }
  };

  const label = "text-[12px] text-ink-secondary md:pt-2";

  return (
    <div className="flex flex-col gap-6">
      {/* Guided */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Guided · no model call</span>
          <span className="text-[12px] text-ink-muted">Fills the New plan form; nothing is saved here.</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[110px_1fr] gap-x-4 gap-y-3 items-start">
          <span className={label}>Amount / run</span>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-center">
            <Segmented size="sm" ariaLabel="Amount per run" value={amountChoice} onChange={(v) => (v === "custom" ? setAmountChoice("custom") : chooseAmount(v))} options={[...AMOUNTS.map((v) => ({ value: v as AmountChoice, label: `$${v}` })), { value: "custom" as AmountChoice, label: "Custom" }]} />
            <label className={cx("flex items-center h-9 rounded-[6px] border px-2 gap-1 text-[13px] transition-fast focus-within:border-primary", amountChoice === "custom" ? "border-primary" : "border-line-strong")}>
              <span className="text-ink-secondary">$</span>
              <input type="number" inputMode="decimal" min={MIN_TRADE_USD} max={MAX_AMOUNT} step="any" value={amount} onFocus={() => setAmountChoice("custom")} onChange={(e) => chooseAmount(Math.min(MAX_AMOUNT, Math.max(MIN_TRADE_USD, Number(e.target.value) || MIN_TRADE_USD)))} aria-label="Custom amount per run" className="w-20 bg-transparent outline-none num text-right" />
              <span className="text-[11px] text-ink-muted">per run</span>
            </label>
          </div>

          <span className={label}>Cadence</span>
          <Segmented size="sm" ariaLabel="Cadence" value={cadence} onChange={setCadence} options={CADENCES.map((c) => ({ value: c.days, label: c.label }))} />

          <span className={label}>
            Stocks
            {picked.length > 0 && <span className="block font-mono text-[10px] text-ink-muted">{picked.length} picked</span>}
          </span>
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-1.5">
              {live.map((a) => {
                const on = picked.includes(a.underlying);
                return (
                  <button key={a.canonicalId} type="button" aria-pressed={on} onClick={() => setPicked(on ? picked.filter((x) => x !== a.underlying) : [...picked, a.underlying])} className={cx("h-9 px-2 rounded-[6px] border text-[12px] font-medium transition-fast inline-flex items-center justify-center gap-1.5 min-w-0", on ? "border-primary text-primary bg-primary-soft" : "border-line text-ink-secondary hover:border-line-strong hover:text-ink")}>
                    <AssetLogo src={a.logoURI} symbol={a.symbol} size={16} />
                    <span className="truncate">{a.underlying}</span>
                  </button>
                );
              })}
              {live.length === 0 && <span className="text-[12px] text-ink-muted col-span-full">No live stocks right now.</span>}
            </div>
            {live.length > 0 && (
              <div className="flex gap-3 text-[12px]">
                <button type="button" className="text-primary font-medium" onClick={() => setPicked(live.map((a) => a.underlying))}>
                  All live
                </button>
                <button type="button" className="text-ink-secondary hover:text-ink" onClick={() => setPicked([])}>
                  Clear
                </button>
              </div>
            )}
          </div>

          <span className={label}>Cash</span>
          <Segmented size="sm" ariaLabel="Cash share" value={cash} onChange={setCash} options={CASH.map((c) => ({ value: c, label: c === 0 ? "None" : `${c}% USDC` }))} className="md:max-w-[360px]" />
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-3 border border-line rounded-[6px] px-3 py-2.5">
          <p className={cx("text-[13px] flex-1 min-w-0", chosen.length === 0 ? "text-ink-muted" : "text-ink")}>{summary}</p>
          <Button size="sm" variant="secondary" onClick={applyGuided} disabled={chosen.length === 0} className="shrink-0">
            <Wand2 size={14} strokeWidth={1.75} /> Fill the plan form
          </Button>
        </div>
        {tooSmall && <p className="text-[12px] text-warning-fg">At {formatUsd(amount)} each stock gets {formatUsd(perStock)}, under the {formatUsd(MIN_TRADE_USD)} per-leg minimum; those legs would be skipped every run. Raise the amount or pick fewer stocks.</p>}
      </section>

      {/* Free text */}
      <section className="border-t border-line pt-4 flex flex-col gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Or describe it · assistant</span>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitAi();
            }}
            maxLength={300}
            placeholder={live[0] ? `e.g. Buy $25 of ${live[0].underlying} every week` : "e.g. Buy $25 of a stock every week"}
            aria-label="Describe the plan"
            className="flex-1 h-11 rounded-[6px] border border-line-strong focus:border-primary bg-canvas px-3 text-[15px] placeholder:text-ink-muted"
          />
          <Button size="md" loading={loading} disabled={prompt.trim().length < 3} onClick={submitAi} className="h-11 sm:min-w-[120px]">
            <Sparkles size={14} strokeWidth={1.75} /> Draft
          </Button>
        </div>
        <p className="text-[12px] text-ink-muted">
          Live stocks today: {live.length > 0 ? live.map((a) => a.underlying).join(", ") : "none"}. The assistant only names these, never executes, and is not advice. <AiQuotaNote remaining={remaining} />
        </p>
      </section>

      {notes && <p className="text-[13px] text-ink-secondary border-l-2 border-primary pl-3">{notes} Review it under New plan.</p>}
      {errors.map((e) => (
        <ErrorBanner key={e} message={e} />
      ))}
    </div>
  );
}
