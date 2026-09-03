"use client";

import { useState } from "react";
import { Sparkles, Wand2 } from "lucide-react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { apiPost, ApiError, type AutomationDraft } from "@/lib/client-api";
import { useAssets } from "@/hooks/queries";
import { Button, Chip, cx } from "@/components/ui/primitives";
import { ErrorBanner } from "@/components/common/display";

type Resp = { ok: boolean; draft?: AutomationDraft; errors?: string[]; warnings?: string[]; quota?: { remainingForWallet: number } };

const AMOUNTS = [10, 25, 50, 100] as const;
const CADENCES = [
  { days: 1, label: "Daily" },
  { days: 7, label: "Weekly" },
  { days: 14, label: "Biweekly" },
  { days: 30, label: "Monthly" },
] as const;
const CASH = [0, 10, 20] as const;

/**
 * Plan drafting in two lanes. Guided: pick amount, cadence, stocks and cash, and the plan is built
 * deterministically without a model call. Free text: one sentence goes to the assistant, which
 * only knows live tickers. Either way the result prefills the form; saving and every run stay manual.
 */
export function AiRuleDraft({ onDraft }: { onDraft: (draft: AutomationDraft) => void }) {
  const { address } = useAccount();
  const { data: assets } = useAssets();
  const live = (assets?.assets ?? []).filter((a) => BigInt(a.totalSupply ?? "0") > 0n);
  const [amount, setAmount] = useState<number>(25);
  const [cadence, setCadence] = useState<number>(7);
  const [picked, setPicked] = useState<string[]>([]);
  const [cash, setCash] = useState<number>(0);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  const applyGuided = () => {
    setErrors([]);
    const chosen = live.filter((a) => picked.includes(a.underlying));
    if (chosen.length === 0) {
      setErrors(["Pick at least one live stock."]);
      return;
    }
    if (chosen.length === 1 && cash === 0) {
      const a = chosen[0]!;
      const draft: AutomationDraft = { type: "recurring-buy", assetAddress: a.address as Address, symbol: a.underlying, amountUsd: amount, cadenceDays: cadence, notes: `Buy $${amount} of ${a.underlying} every ${cadenceLabel(cadence)}.` };
      onDraft(draft);
      setNotes(draft.notes);
      return;
    }
    const stockBps = 10_000 - cash * 100;
    const each = Math.floor(stockBps / chosen.length);
    const allocations = chosen.map((a, i) => ({ assetAddress: a.address as Address, weightBps: each + (i === 0 ? stockBps - each * chosen.length : 0) }));
    if (cash > 0) allocations.push({ assetAddress: "USDC" as unknown as Address, weightBps: cash * 100 });
    const draft: AutomationDraft = { type: "recurring-basket", basketName: `${chosen.map((a) => a.underlying).join(" + ")}${cash ? ` + ${cash}% USDC` : ""}`, allocations, amountUsd: amount, cadenceDays: cadence, notes: `Invest $${amount} every ${cadenceLabel(cadence)} split equally across ${chosen.map((a) => a.underlying).join(", ")}${cash ? ` with ${cash}% kept as USDC` : ""}.` };
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
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">Guided · no model call</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-x-4 gap-y-2 items-center">
          <span className="text-[12px] text-ink-secondary">Amount / run</span>
          <div className="flex gap-1.5 flex-wrap">
            {AMOUNTS.map((v) => (
              <Chip key={v} active={amount === v} onClick={() => setAmount(v)} className="h-8 min-h-[32px] px-3 text-[12px]">
                ${v}
              </Chip>
            ))}
            <label className={cx("flex items-center h-8 rounded-[6px] border px-2 gap-1 text-[12px] transition-fast focus-within:border-primary", (AMOUNTS as readonly number[]).includes(amount) ? "border-line-strong text-ink-secondary" : "border-primary text-ink")}>
              <span>$</span>
              <input type="number" inputMode="decimal" min={1} step="any" placeholder="Custom" aria-label="Custom amount per run" value={(AMOUNTS as readonly number[]).includes(amount) ? "" : amount} onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 1))} className="w-16 bg-transparent outline-none num placeholder:text-ink-muted" />
            </label>
          </div>
          <span className="text-[12px] text-ink-secondary">Cadence</span>
          <div className="flex gap-1.5 flex-wrap">
            {CADENCES.map((c) => (
              <Chip key={c.days} active={cadence === c.days} onClick={() => setCadence(c.days)} className="h-8 min-h-[32px] px-3 text-[12px]">
                {c.label}
              </Chip>
            ))}
          </div>
          <span className="text-[12px] text-ink-secondary">Stocks</span>
          <div className="flex gap-1.5 flex-wrap">
            {live.map((a) => {
              const on = picked.includes(a.underlying);
              return (
                <button key={a.canonicalId} type="button" aria-pressed={on} onClick={() => setPicked(on ? picked.filter((x) => x !== a.underlying) : [...picked, a.underlying])} className={cx("h-8 px-3 rounded-[5px] border text-[12px] font-medium transition-fast", on ? "border-primary text-primary bg-primary-soft" : "border-line text-ink-secondary hover:border-line-strong")}>
                  {a.underlying}
                </button>
              );
            })}
            {live.length === 0 && <span className="text-[12px] text-ink-muted">No live stocks right now.</span>}
          </div>
          <span className="text-[12px] text-ink-secondary">Cash</span>
          <div className="flex gap-1.5 flex-wrap">
            {CASH.map((c) => (
              <Chip key={c} active={cash === c} onClick={() => setCash(c)} className="h-8 min-h-[32px] px-3 text-[12px]">
                {c === 0 ? "None" : `${c}% USDC`}
              </Chip>
            ))}
          </div>
        </div>
        <Button size="md" variant="secondary" onClick={applyGuided} disabled={picked.length === 0} className="self-start">
          <Wand2 size={14} strokeWidth={1.75} /> Fill the plan form
        </Button>
      </div>

      <div className="border-t border-line pt-3 flex flex-col gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">Or describe it · assistant</span>
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
          Live stocks today: {live.length > 0 ? live.map((a) => a.underlying).join(", ") : "none"}. The assistant only names these, never executes, and is not advice.{remaining !== null ? ` ${remaining} drafts left today.` : ""}
        </p>
      </div>
      {notes && <p className="text-[13px] text-ink-secondary border-l-2 border-primary pl-3">{notes} Review it in the form.</p>}
      {errors.map((e) => (
        <ErrorBanner key={e} message={e} />
      ))}
    </div>
  );
}

function cadenceLabel(days: number): string {
  return days === 1 ? "day" : days === 7 ? "week" : days === 14 ? "two weeks" : "month";
}
