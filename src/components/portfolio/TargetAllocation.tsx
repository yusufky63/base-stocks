"use client";

import { useMutation } from "@tanstack/react-query";
import { Bookmark, BookmarkCheck, Trash2 } from "lucide-react";
import type { AutomationRule } from "@/domain/community";
import type { Allocation, PortfolioSnapshot } from "@/domain/portfolio";
import { apiPatch, apiPost } from "@/lib/client-api";
import { useAuth } from "@/hooks/useAuth";
import { useAutomation } from "@/hooks/useAutomation";
import { currentMix } from "@/lib/portfolio/drift";
import { Button, Chip } from "@/components/ui/primitives";

/** Sentinel id for "the mix I saved", kept out of the template id space. */
export const MY_TARGET_ID = "__my_target__";

/** How far the mix may drift before the page says something, unless the rule carries its own. */
export const DEFAULT_THRESHOLD_BPS = 500;
export const THRESHOLD_CHOICES = [250, 500, 1000] as const;

export interface SavedTarget {
  rule: AutomationRule | null;
  allocations: Allocation[] | null;
  thresholdBps: number;
  signedIn: boolean;
  save: (allocations: Allocation[]) => Promise<void>;
  clear: () => Promise<void>;
  setThreshold: (bps: number) => Promise<void>;
  saving: boolean;
}

/**
 * A wallet's own target mix, stored as the `drift-alert` rule. One per wallet: a second "what I
 * am aiming at" is not a feature, it is a question nobody can answer. It is never a plan: the
 * Automate page and the Portfolio card filter it out, and nothing can run it.
 */
export function useTargetAllocation(): SavedTarget {
  const auth = useAuth();
  const automation = useAutomation();
  const rule = automation.target;

  const save = useMutation({
    mutationFn: async (allocations: Allocation[]) => {
      await auth.ensureSignedIn();
      // One target per wallet: replace rather than pile up.
      for (const r of automation.rules.filter((x) => x.type === "drift-alert")) await apiPatch("/api/automation", { id: r.id, action: "delete" }).catch(() => undefined);
      await apiPost("/api/automation", { type: "drift-alert", allocations, thresholdBps: rule?.config.thresholdBps ?? DEFAULT_THRESHOLD_BPS });
    },
    onSuccess: () => automation.invalidate(),
  });

  const clear = useMutation({
    mutationFn: async () => {
      if (!rule) return;
      await auth.ensureSignedIn();
      await apiPatch("/api/automation", { id: rule.id, action: "delete" });
    },
    onSuccess: () => automation.invalidate(),
  });

  const threshold = useMutation({
    mutationFn: async (thresholdBps: number) => {
      if (!rule) return;
      await auth.ensureSignedIn();
      await apiPatch("/api/automation", { id: rule.id, action: "threshold", thresholdBps });
    },
    onSuccess: () => automation.invalidate(),
  });

  return {
    rule,
    allocations: rule?.config.allocations ?? null,
    thresholdBps: rule?.config.thresholdBps ?? DEFAULT_THRESHOLD_BPS,
    signedIn: auth.isSignedIn,
    save: async (a) => void (await save.mutateAsync(a)),
    clear: async () => void (await clear.mutateAsync()),
    setThreshold: async (bps) => void (await threshold.mutateAsync(bps)),
    saving: save.isPending || clear.isPending || threshold.isPending,
  };
}

/** Save / replace / clear, and the drift threshold, shown under the drift table. */
export function TargetControls({
  snapshot,
  target,
  saved,
}: {
  snapshot: PortfolioSnapshot;
  target?: { id: string; name: string; allocations: Allocation[] };
  saved: SavedTarget;
}) {
  const current = currentMix(snapshot);
  const isSavedTarget = target?.id === MY_TARGET_ID;

  if (!saved.signedIn) {
    return (
      <div className="px-4 py-3 border-t border-line flex flex-wrap items-center gap-3">
        <p className="text-[12px] text-ink-secondary flex-1 min-w-[220px]">Sign in to save a target mix. It is stored against your wallet; nothing runs from it, it only tells this page when to speak up.</p>
        <Button size="sm" variant="secondary" loading={saved.saving} onClick={() => void saved.save(current)} disabled={current.length === 0}>
          <Bookmark size={13} strokeWidth={1.75} /> Save this mix as my target
        </Button>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 border-t border-line flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {!isSavedTarget && target && (
          <Button size="sm" variant="secondary" loading={saved.saving} onClick={() => void saved.save(target.allocations)}>
            <Bookmark size={13} strokeWidth={1.75} /> {`Use ${target.name} as my target`}
          </Button>
        )}
        <Button size="sm" variant="secondary" loading={saved.saving} disabled={current.length === 0} onClick={() => void saved.save(current)}>
          {saved.allocations ? <BookmarkCheck size={13} strokeWidth={1.75} /> : <Bookmark size={13} strokeWidth={1.75} />}
          {saved.allocations ? "Reset target to today's mix" : "Save this mix as my target"}
        </Button>
        {saved.allocations && (
          <Button size="sm" variant="secondary" loading={saved.saving} onClick={() => void saved.clear()}>
            <Trash2 size={13} strokeWidth={1.75} /> Clear target
          </Button>
        )}
      </div>
      {saved.allocations && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-secondary">
          <span>Flag drift from</span>
          {THRESHOLD_CHOICES.map((bps) => (
            <Chip key={bps} active={saved.thresholdBps === bps} disabled={saved.saving} onClick={() => void saved.setThreshold(bps)} className="h-8 min-h-[32px] px-2.5 text-[12px]">
              {bps / 100}%
            </Chip>
          ))}
          <span className="text-ink-muted">on any leg. Cash in Earn and liquidity positions are left out of the measure.</span>
        </div>
      )}
    </div>
  );
}
