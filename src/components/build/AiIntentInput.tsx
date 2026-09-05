"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { useAccount } from "wagmi";
import { apiPost, ApiError, type IntentResponse } from "@/lib/client-api";
import { useAssets } from "@/hooks/queries";
import { tradingStatus } from "@/lib/trading-status";
import { AssetLogo, AiQuotaNote, ErrorBanner } from "@/components/common/display";
import { Button, cx } from "@/components/ui/primitives";
import { OptionTiles } from "@/components/ui/OptionTiles";
import { Segmented } from "@/components/ui/Segmented";

type Resp = IntentResponse & { warnings?: string[]; quota?: { remainingForWallet: number; remainingForIp: number }; sent?: string };

const THEMES = [
  { id: "AI & chips", label: "AI & chips", hint: "Compute, models, memory" },
  { id: "Big tech", label: "Big tech", hint: "The largest platforms" },
  { id: "Crypto economy", label: "Crypto economy", hint: "Exchanges, treasuries" },
  { id: "Broad market", label: "Broad market", hint: "A bit of everything live" },
  { id: "Defensive", label: "Defensive", hint: "Cash-rich, steadier names" },
] as const;
type Theme = (typeof THEMES)[number]["id"];

const RISKS = [
  { id: "concentrated", label: "Concentrated", hint: "3–4 names, largest up to 50%" },
  { id: "balanced", label: "Balanced", hint: "5–7 names, none above 30%" },
  { id: "broad", label: "Broad", hint: "Every live name, near-equal" },
] as const;
type Risk = (typeof RISKS)[number]["id"];

const CASH = [0, 10, 20, 30] as const;

/**
 * Guided AI drafting: a theme and a risk profile are enough; cash, exclusions and not-issued names
 * are one row each. The server adds the live status and liquidity of every stock, the shared market
 * brief and recent headlines, re-validates the answer and returns it with a "why this mix".
 */
export function AiIntentInput({ onIntent }: { onIntent: (intent: NonNullable<IntentResponse["intent"]>) => void }) {
  const { address } = useAccount();
  const { data: assets } = useAssets();
  const [theme, setTheme] = useState<Theme | null>("AI & chips");
  const [risk, setRisk] = useState<Risk>("balanced");
  const [cash, setCash] = useState<number>(10);
  const [avoid, setAvoid] = useState<string[]>([]);
  const [liveOnly, setLiveOnly] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  const all = assets?.assets ?? [];
  const label = "text-[12px] text-ink-secondary md:pt-2.5";

  const submit = async () => {
    if (loading) return;
    setLoading(true);
    setErrors([]);
    setNotes(null);
    try {
      const res = await apiPost<Resp>("/api/portfolio/intent", { prompt: prompt.trim() || undefined, owner: address, guided: { theme: theme ?? undefined, risk, cashPct: cash, exclude: avoid, liveOnly } });
      if (res.quota) setRemaining(res.quota.remainingForWallet);
      if (!res.ok || !res.intent) {
        setErrors(res.errors ?? ["No basket could be produced."]);
        return;
      }
      onIntent(res.intent);
      setNotes([res.intent.notes, ...(res.warnings ?? [])].filter(Boolean).join(" "));
    } catch (err) {
      setErrors([err instanceof ApiError ? err.message : "AI assistance is unavailable right now."]);
      const quota = err instanceof ApiError ? (err.body?.quota as { remainingForWallet?: number } | undefined) : undefined;
      if (typeof quota?.remainingForWallet === "number") setRemaining(quota.remainingForWallet);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 md:grid-cols-[96px_1fr] gap-x-4 gap-y-3 items-start">
        <span className={label}>Theme</span>
        <OptionTiles ariaLabel="Theme" value={theme} onChange={(v) => setTheme(v)} clearable options={THEMES.map((t) => ({ value: t.id, label: t.label, hint: t.hint }))} />

        <span className={label}>Risk</span>
        <OptionTiles ariaLabel="Risk profile" value={risk} onChange={setRisk} columns="grid-cols-1 sm:grid-cols-3" options={RISKS.map((r) => ({ value: r.id, label: r.label, hint: r.hint }))} />

        <span className={label}>Cash</span>
        <Segmented size="sm" ariaLabel="Cash share" value={cash} onChange={setCash} options={CASH.map((c) => ({ value: c, label: c === 0 ? "None" : `${c}% USDC` }))} className="md:max-w-[420px]" />

        <span className={label}>
          Leave out
          <span className="block text-[11px] text-ink-muted">optional</span>
        </span>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {all.map((a) => {
              const on = avoid.includes(a.underlying);
              const status = tradingStatus(a, assets?.prices[a.canonicalId]).status;
              const live = status !== "not-issued";
              return (
                <button key={a.canonicalId} type="button" aria-pressed={on} onClick={() => setAvoid(on ? avoid.filter((x) => x !== a.underlying) : [...avoid, a.underlying])} className={cx("h-8 pl-1.5 pr-2.5 rounded-[6px] border text-[12px] font-medium transition-fast inline-flex items-center gap-1.5", on ? "border-danger-fg text-danger-fg line-through" : "border-line text-ink-secondary hover:border-line-strong", !live && "opacity-55")} title={live ? "Tap to leave this stock out" : "Not issued yet; drafts skip it unless you include not-issued names"}>
                  <AssetLogo src={a.logoURI} symbol={a.symbol} size={16} />
                  {a.underlying}
                </button>
              );
            })}
          </div>
          <label className="inline-flex items-center gap-1.5 text-[12px] text-ink-secondary cursor-pointer select-none">
            <input type="checkbox" checked={!liveOnly} onChange={(e) => setLiveOnly(!e.target.checked)} className="h-3.5 w-3.5 accent-[var(--color-primary)]" /> Allow names not issued yet (their share waits as USDC)
          </label>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-2 md:items-center border-t border-line pt-4">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          maxLength={400}
          placeholder="Optional: in your words — e.g. tilt toward chips, keep Apple under 15%"
          aria-label="Extra instructions for the draft"
          className="flex-1 h-11 rounded-[6px] border border-line-strong focus:border-primary bg-canvas px-3 text-[15px] placeholder:text-ink-muted"
        />
        <Button size="md" loading={loading} disabled={!theme && prompt.trim().length < 3} onClick={submit} className="md:min-w-[170px] h-11">
          <Sparkles size={14} strokeWidth={1.75} /> Draft basket
        </Button>
      </div>

      <p className="text-[12px] text-ink-muted">
        Uses the live status and liquidity of each stock, the shared market brief and recent headlines. The draft lands in the editor below with a note on why; you edit and confirm. Not advice. <AiQuotaNote remaining={remaining} />
      </p>
      {notes && <p className="text-[13px] text-ink-secondary border-l-2 border-primary pl-3">{notes}</p>}
      {errors.map((e) => (
        <ErrorBanner key={e} message={e} />
      ))}
    </div>
  );
}
