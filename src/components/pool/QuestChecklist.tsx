"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Circle, ExternalLink, Globe, ShieldCheck } from "lucide-react";
import type { QuestStatus } from "@/domain/pool";
import { apiPost, ApiError } from "@/lib/client-api";
import { XMark } from "@/components/brand/Logo";
import { Button, LinkButton, Skeleton, cx } from "@/components/ui/primitives";

/** How long the confirmation window runs after someone says they did a declared step. */
const CONFIRM_MS = 5_000;

interface Props {
  poolId: string;
  isSignedIn: boolean;
  data?: { quests: QuestStatus[]; eligible: boolean; alreadyClaimed: boolean };
  loading: boolean;
  onSignIn: () => void;
  onChanged: () => void;
}

/**
 * What a claimant still has to do before a quest-gated pool will pay them.
 *
 * Two kinds of row, and the list never blurs them. Checked steps (Basename, balance, a purchase)
 * are read from the chain and simply say done or not. Declared steps open a link — an X profile,
 * a post, a page — and then wait on the claimant's own confirmation, because nobody can see a
 * follow, a repost, a like or a page view from outside. Those rows say "confirmed by you", not
 * "verified", and the creator's roster shows the same distinction.
 */
export function QuestChecklist({ poolId, isSignedIn, data, loading, onSignIn, onChanged }: Props) {
  const [pending, setPending] = useState<number | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const t = timers.current;
    return () => t.forEach((id) => window.clearInterval(id));
  }, []);

  const confirm = (q: QuestStatus) => {
    if (pending !== null) return;
    setError(null);
    if (q.actionUrl) window.open(q.actionUrl, "_blank", "noopener,noreferrer");
    setPending(q.index);
    setLeft(Math.ceil(CONFIRM_MS / 1000));

    const countdown = window.setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    timers.current.push(countdown);

    const done = window.setTimeout(async () => {
      window.clearInterval(countdown);
      try {
        await apiPost(`/api/pools/${poolId}/attest`, { questIndex: q.index });
        onChanged();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "That did not go through. Try again in a moment.");
      } finally {
        setPending(null);
      }
    }, CONFIRM_MS);
    timers.current.push(done);
  };

  if (!isSignedIn) {
    return (
      <div className="border border-line rounded-[8px] p-4 flex flex-col gap-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">This pool has steps</span>
        <p className="text-[13px] text-ink-secondary">Sign in with your wallet so we can check them off. It is one signature, costs nothing and approves no transaction.</p>
        <Button size="sm" onClick={onSignIn}>
          Sign in to continue
        </Button>
      </div>
    );
  }
  if (loading || !data) return <Skeleton className="h-24" />;

  const remaining = data.quests.filter((q) => !q.done).length;
  const declaredCount = data.quests.filter((q) => q.selfDeclared).length;

  return (
    <div className="border border-line rounded-[8px] overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-surface border-b border-line">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
          {remaining === 0 ? "All steps done" : `${remaining} step${remaining > 1 ? "s" : ""} left`}
        </span>
        <span className="font-mono num text-[11px] text-ink-muted">{`${data.quests.length - remaining}/${data.quests.length}`}</span>
      </div>

      <ul>
        {data.quests.map((q) => {
          const busy = pending === q.index;
          return (
            <li key={q.index} className="relative border-b border-line last:border-b-0">
              <div className="flex items-start gap-2.5 px-3.5 py-3">
                <span className="mt-0.5 shrink-0">
                  {q.done ? (
                    <Check size={15} strokeWidth={2.5} className="text-positive-fg" />
                  ) : q.type === "visit-url" ? (
                    <Globe size={14} strokeWidth={1.75} className="text-ink-muted" />
                  ) : q.selfDeclared ? (
                    <XMark size={13} className="text-ink-muted" />
                  ) : (
                    <Circle size={15} strokeWidth={1.75} className="text-ink-muted" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cx("block text-[13px]", q.done ? "text-ink-secondary line-through" : "font-medium")}>{q.label}</span>
                  {q.done && q.selfDeclared && <span className="block text-[11px] text-ink-muted">Confirmed by you</span>}
                  {!q.done && !busy && q.detail && <span className="block text-[12px] text-ink-muted">{q.detail}</span>}
                  {busy && (
                    <span className="block text-[12px] text-ink-muted num">{left > 0 ? `Checking… ${left}s` : "Almost there…"}</span>
                  )}
                </span>
                {!q.done && q.selfDeclared && (
                  <Button size="sm" variant="secondary" loading={busy} disabled={pending !== null && !busy} onClick={() => confirm(q)} className="shrink-0">
                    {busy ? "Checking" : (
                      <>
                        Do it <ExternalLink size={12} strokeWidth={2} />
                      </>
                    )}
                  </Button>
                )}
                {/* Checked asset steps: no attestation — send the claimant to buy, the chain proves it on return. */}
                {!q.done && !q.selfDeclared && q.actionUrl && (q.type === "buy-asset" || q.type === "hold-asset") && (
                  <LinkButton href={q.actionUrl} size="sm" variant="primary" className="shrink-0">
                    Buy <ArrowRight size={12} strokeWidth={2} />
                  </LinkButton>
                )}
              </div>
              {busy && (
                <span aria-hidden className="absolute bottom-0 left-0 h-[2px] w-full bg-primary quest-fill" style={{ ["--quest-duration" as string]: `${CONFIRM_MS}ms` }} />
              )}
            </li>
          );
        })}
      </ul>

      {error && <p className="px-3.5 py-2 text-[12px] text-danger-fg border-t border-line">{error}</p>}

      <p className="px-3.5 py-2.5 text-[11px] text-ink-muted border-t border-line flex items-start gap-1.5">
        <ShieldCheck size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" />
        {declaredCount > 0
          ? "Onchain steps are read from Base. The rest are confirmed by you — a follow, a repost, a like or a page view cannot be checked from outside."
          : "Every step here is read from Base, not taken on trust."}
      </p>
    </div>
  );
}
