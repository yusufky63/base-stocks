"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import type { Address } from "viem";
import type { PortfolioDigest } from "@/domain/digest";
import { apiGet, apiPost, ApiError } from "@/lib/client-api";
import { useAuth } from "@/hooks/useAuth";
import { Button, Module, ModuleHeader, Skeleton } from "@/components/ui/primitives";
import { SignInButton } from "@/components/layout/SignInButton";

type Resp = { ok: boolean; digest?: PortfolioDigest; errors?: string[]; quota?: { remainingForWallet: number } };

/**
 * "Your day": a per-wallet summary generated once per UTC day on request (sign-in required so the
 * cost cannot be triggered by strangers). Holdings, cash, Earn, LP, last-24h activity and headlines
 * about held stocks are sent to the AI provider for this; nothing else.
 */
export function PortfolioDigestCard({ address }: { address: Address }) {
  const auth = useAuth();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const stored = useQuery({ queryKey: ["portfolio", "digest", address.toLowerCase(), auth.isSignedIn], queryFn: () => apiGet<{ enabled: boolean; digest: PortfolioDigest | null }>("/api/portfolio/digest"), enabled: auth.isSignedIn, staleTime: 5 * 60_000 });
  const generate = useMutation({
    mutationFn: async () => {
      await auth.ensureSignedIn();
      return apiPost<Resp>("/api/portfolio/digest", {});
    },
    onSuccess: (r) => {
      setError(null);
      if (!r.ok) setError(r.errors?.[0] ?? "No summary available.");
      void qc.invalidateQueries({ queryKey: ["portfolio", "digest"] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "AI assistance is unavailable right now."),
  });
  if (stored.data && !stored.data.enabled) return null;
  const d = stored.data?.digest ?? null;
  const day = new Date().toISOString().slice(0, 10);

  return (
    <Module>
      <ModuleHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Sparkles size={14} strokeWidth={1.75} className="text-primary" /> Your day
          </span>
        }
        action={d ? <span className="font-mono text-[11px] text-ink-muted">{new Date(d.generatedAt).toISOString().slice(11, 16)} UTC · {day}</span> : undefined}
      />
      <div className="p-4 flex flex-col gap-3">
        {!auth.isSignedIn ? (
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <p className="text-[13px] text-ink-secondary">A one-paragraph summary of your holdings, moves and related headlines, once a day. Sign in to generate it for this wallet.</p>
            <SignInButton label="Sign in" />
          </div>
        ) : stored.isLoading ? (
          <Skeleton className="h-12" />
        ) : d ? (
          <>
            <p className="text-[15px] font-medium leading-snug">{d.headline}</p>
            <p className="text-[14px] text-ink-secondary leading-relaxed">{d.summary}</p>
            {d.highlights.length > 0 && (
              <ul className="list-disc pl-4 text-[13px] text-ink-secondary flex flex-col gap-1">
                {d.highlights.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            )}
            {d.watch.length > 0 && (
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1">In the news</div>
                <ul className="list-disc pl-4 text-[13px] text-ink-secondary flex flex-col gap-1">
                  {d.watch.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-[11px] text-ink-muted">Generated once per day from your onchain balances, last-24h activity and headlines about held stocks. Not advice.</p>
          </>
        ) : (
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <p className="text-[13px] text-ink-secondary">No summary for today yet. It costs one AI request from your daily allowance; your holdings, activity and related headlines are sent to the AI provider to write it.</p>
            <Button size="sm" loading={generate.isPending} onClick={() => generate.mutate()}>
              <Sparkles size={14} strokeWidth={1.75} /> Summarize my day
            </Button>
          </div>
        )}
        {error && <p className="text-[13px] text-danger-fg">{error}</p>}
      </div>
    </Module>
  );
}
