"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { useAccount } from "wagmi";
import type { Allocation } from "@/domain/portfolio";
import { apiPost, ApiError, type IntentResponse } from "@/lib/client-api";
import { useAssets } from "@/hooks/queries";
import { formatUsdCompact } from "@/lib/format";
import { Button, Chip, cx } from "@/components/ui/primitives";
import { ErrorBanner } from "@/components/common/display";

type Resp = IntentResponse & { warnings?: string[]; quota?: { remainingForWallet: number; remainingForIp: number }; sent?: string };

const THEMES = ["AI & chips", "Big tech", "Crypto economy", "Broad market", "Defensive"] as const;
const RISKS = [
  { id: "concentrated", label: "Concentrated", hint: "3–4 names" },
  { id: "balanced", label: "Balanced", hint: "5–7 names" },
  { id: "broad", label: "Broad", hint: "all live names" },
] as const;
const CASH = [0, 10, 20, 30] as const;

/**
 * Guided AI drafting (spec §4.5): the request is composed from choices (theme, risk profile, cash,
 * exclusions) plus optional free text, and the server adds live market context (price, 24h move,
 * liquidity, issued or not) before asking the model. Output is a draft you review; nothing executes.
 */
export function AiIntentInput({ onIntent }: { onIntent: (intent: { name?: string; allocations: Allocation[]; notes?: string }) => void }) {
  const { address } = useAccount();
  const { data: assets } = useAssets();
  const [theme, setTheme] = useState<(typeof THEMES)[number] | null>("AI & chips");
  const [risk, setRisk] = useState<(typeof RISKS)[number]["id"]>("balanced");
  const [cash, setCash] = useState<(typeof CASH)[number]>(10);
  const [avoid, setAvoid] = useState<string[]>([]);
  const [liveOnly, setLiveOnly] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  const all = assets?.assets ?? [];
  const live = all.filter((a) => BigInt(a.totalSupply ?? "0") > 0n);
  const liquidity = live.reduce((s, a) => s + (assets?.prices[a.canonicalId]?.liquidityUsd ?? 0), 0);

  const submit = async () => {
    if (loading) return;
    setLoading(true);
    setErrors([]);
    setNotes(null);
    try {
      const res = await apiPost<Resp>("/api/portfolio/intent", {
        prompt: prompt.trim() || undefined,
        owner: address,
        guided: { theme: theme ?? undefined, risk, cashPct: cash, exclude: avoid, liveOnly },
      });
      if (res.quota) setRemaining(res.quota.remainingForWallet);
      if (res.sent) setSent(res.sent);
      if (!res.ok || !res.intent) {
        setErrors(res.errors ?? ["No basket could be produced."]);
        return;
      }
      onIntent(res.intent);
      setNotes([res.intent.notes, ...(res.warnings ?? [])].filter(Boolean).join(" "));
    } catch (err) {
      setErrors([err instanceof ApiError ? err.message : "AI assistance is unavailable right now."]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-x-4 gap-y-2 items-center">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">Theme</span>
        <div className="flex gap-1.5 flex-wrap">
          {THEMES.map((t) => (
            <Chip key={t} active={theme === t} onClick={() => setTheme(theme === t ? null : t)} className="h-8 min-h-[32px] px-3 text-[12px]">
              {t}
            </Chip>
          ))}
        </div>
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">Risk</span>
        <div className="flex gap-1.5 flex-wrap">
          {RISKS.map((r) => (
            <Chip key={r.id} active={risk === r.id} onClick={() => setRisk(r.id)} className="h-8 min-h-[32px] px-3 text-[12px]" title={r.hint}>
              {r.label} <span className="text-ink-muted font-normal">· {r.hint}</span>
            </Chip>
          ))}
        </div>
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">Cash</span>
        <div className="flex gap-1.5 flex-wrap">
          {CASH.map((c) => (
            <Chip key={c} active={cash === c} onClick={() => setCash(c)} className="h-8 min-h-[32px] px-3 text-[12px]">
              {c === 0 ? "None" : `${c}% USDC`}
            </Chip>
          ))}
        </div>
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">Avoid</span>
        <div className="flex gap-1.5 flex-wrap items-center">
          {all.map((a) => {
            const on = avoid.includes(a.underlying);
            const isLive = BigInt(a.totalSupply ?? "0") > 0n;
            return (
              <button key={a.canonicalId} type="button" aria-pressed={on} onClick={() => setAvoid(on ? avoid.filter((x) => x !== a.underlying) : [...avoid, a.underlying])} className={cx("h-7 px-2 rounded-[5px] border text-[12px] font-medium transition-fast", on ? "border-danger-fg text-danger-fg line-through" : "border-line text-ink-secondary hover:border-ink", !isLive && "opacity-60")} title={isLive ? undefined : "not issued yet"}>
                {a.underlying}
              </button>
            );
          })}
          <label className="ml-1 inline-flex items-center gap-1.5 text-[12px] text-ink-secondary cursor-pointer">
            <input type="checkbox" checked={liveOnly} onChange={(e) => setLiveOnly(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--color-primary)]" /> live markets only
          </label>
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
          placeholder="Optional detail — e.g. tilt toward chips, keep Apple under 15%"
          aria-label="Extra instructions for the draft"
          className="flex-1 h-11 rounded-[6px] border border-line-strong focus:border-primary bg-canvas px-3 text-[15px] placeholder:text-ink-muted"
        />
        <Button size="md" loading={loading} disabled={!theme && prompt.trim().length < 3} onClick={submit} className="md:min-w-[150px] h-11">
          <Sparkles size={14} strokeWidth={1.75} /> Draft basket
        </Button>
      </div>

      <div className="flex items-start justify-between gap-3 flex-wrap text-[12px] text-ink-muted">
        <p>
          The assistant sees {live.length} live stocks with price, 24h move and DEX liquidity ({formatUsdCompact(liquidity)} in total) plus sector tags; it weighs by your risk profile and never picks a stock without a market unless you name it. You review every draft; it is not advice.
        </p>
        {remaining !== null && <span className="font-mono text-[11px] shrink-0">{remaining} drafts left today</span>}
      </div>
      {sent && <p className="text-[12px] text-ink-muted font-mono border border-dashed border-line rounded-[6px] px-3 py-2">Sent: {sent}</p>}
      {notes && <p className="text-[13px] text-ink-secondary border-l-2 border-primary pl-3">{notes} Applied to the editor below.</p>}
      {errors.map((e) => (
        <ErrorBanner key={e} message={e} />
      ))}
    </div>
  );
}
