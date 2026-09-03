"use client";

import { useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import { useAccount } from "wagmi";
import type { Allocation } from "@/domain/portfolio";
import { apiPost, ApiError, type IntentResponse } from "@/lib/client-api";
import { useAssets } from "@/hooks/queries";
import { Button, Chip, cx } from "@/components/ui/primitives";
import { AiQuotaNote, ErrorBanner } from "@/components/common/display";

type Resp = IntentResponse & { warnings?: string[]; quota?: { remainingForWallet: number; remainingForIp: number }; sent?: string };

const THEMES = ["AI & chips", "Big tech", "Crypto economy", "Broad market", "Defensive"] as const;
const RISKS = [
  { id: "concentrated", label: "Concentrated" },
  { id: "balanced", label: "Balanced" },
  { id: "broad", label: "Broad" },
] as const;
const CASH = [0, 10, 20, 30] as const;

/**
 * Guided AI drafting: theme + risk (+ optional text) is enough; cash, exclusions and the live-only
 * switch sit behind "More options". The server adds live market context and re-validates.
 */
export function AiIntentInput({ onIntent }: { onIntent: (intent: { name?: string; allocations: Allocation[]; notes?: string }) => void }) {
  const { address } = useAccount();
  const { data: assets } = useAssets();
  const [theme, setTheme] = useState<(typeof THEMES)[number] | null>("AI & chips");
  const [risk, setRisk] = useState<(typeof RISKS)[number]["id"]>("balanced");
  const [cash, setCash] = useState<(typeof CASH)[number]>(10);
  const [avoid, setAvoid] = useState<string[]>([]);
  const [liveOnly, setLiveOnly] = useState(true);
  const [more, setMore] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  const all = assets?.assets ?? [];

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
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex gap-1.5 flex-wrap items-center">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted w-12">Theme</span>
          {THEMES.map((t) => (
            <Chip key={t} active={theme === t} onClick={() => setTheme(theme === t ? null : t)} className="h-8 min-h-[32px] px-3 text-[12px]">
              {t}
            </Chip>
          ))}
        </div>
        <div className="flex gap-1.5 flex-wrap items-center">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted w-12">Risk</span>
          {RISKS.map((r) => (
            <Chip key={r.id} active={risk === r.id} onClick={() => setRisk(r.id)} className="h-8 min-h-[32px] px-3 text-[12px]">
              {r.label}
            </Chip>
          ))}
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-2">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          maxLength={400}
          placeholder="Optional: e.g. tilt toward chips, keep Apple under 15%"
          aria-label="Extra instructions for the draft"
          className="flex-1 h-11 rounded-[6px] border border-line-strong focus:border-primary bg-canvas px-3 text-[15px] placeholder:text-ink-muted"
        />
        <Button size="md" loading={loading} disabled={!theme && prompt.trim().length < 3} onClick={submit} className="md:min-w-[150px] h-11">
          <Sparkles size={14} strokeWidth={1.75} /> Draft basket
        </Button>
      </div>

      <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more} className="self-start inline-flex items-center gap-1 text-[12px] font-medium text-ink-secondary hover:text-ink">
        More options <ChevronDown size={13} strokeWidth={1.75} className={cx("transition-transform", more && "rotate-180")} />
      </button>
      {more && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <div className="flex gap-1.5 flex-wrap items-center">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted w-12">Cash</span>
            {CASH.map((c) => (
              <Chip key={c} active={cash === c} onClick={() => setCash(c)} className="h-8 min-h-[32px] px-3 text-[12px]">
                {c === 0 ? "None" : `${c}% USDC`}
              </Chip>
            ))}
          </div>
          <div className="flex gap-1.5 flex-wrap items-center">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted w-12">Avoid</span>
            {all.map((a) => {
              const on = avoid.includes(a.underlying);
              const isLive = BigInt(a.totalSupply ?? "0") > 0n;
              return (
                <button key={a.canonicalId} type="button" aria-pressed={on} onClick={() => setAvoid(on ? avoid.filter((x) => x !== a.underlying) : [...avoid, a.underlying])} className={cx("h-7 px-2 rounded-[5px] border text-[12px] font-medium transition-fast", on ? "border-danger-fg text-danger-fg line-through" : "border-line text-ink-secondary hover:border-line-strong", !isLive && "opacity-60")} title={isLive ? undefined : "not issued yet"}>
                  {a.underlying}
                </button>
              );
            })}
          </div>
          <label className="inline-flex items-center gap-1.5 text-[12px] text-ink-secondary cursor-pointer">
            <input type="checkbox" checked={liveOnly} onChange={(e) => setLiveOnly(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--color-primary)]" /> live markets only
          </label>
        </div>
      )}

      <p className="text-[12px] text-ink-muted">
        Uses live prices and liquidity. A draft you edit and confirm; not advice. <AiQuotaNote remaining={remaining} />
      </p>
      {notes && <p className="text-[13px] text-ink-secondary border-l-2 border-primary pl-3">{notes}</p>}
      {errors.map((e) => (
        <ErrorBanner key={e} message={e} />
      ))}
    </div>
  );
}
