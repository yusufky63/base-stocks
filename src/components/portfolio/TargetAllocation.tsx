"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, BookmarkCheck, Trash2 } from "lucide-react";
import type { AutomationRule } from "@/domain/community";
import type { Allocation, PortfolioSnapshot } from "@/domain/portfolio";
import { TOTAL_BPS } from "@/domain/portfolio";
import { apiGet, apiPatch, apiPost } from "@/lib/client-api";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/primitives";

/** Sentinel id for "the mix I saved", kept out of the template id space. */
export const MY_TARGET_ID = "__my_target__";

/** How far the mix may drift before the page says something, unless the rule carries its own. */
const DEFAULT_THRESHOLD_BPS = 500;

type RuleDTO = AutomationRule & { due: boolean };

export interface SavedTarget {
  rule: RuleDTO | null;
  allocations: Allocation[] | null;
  thresholdBps: number;
  signedIn: boolean;
  save: (allocations: Allocation[]) => Promise<void>;
  clear: () => Promise<void>;
  saving: boolean;
}

/**
 * A wallet's own target mix, stored as the `drift-alert` rule the automation domain already had a
 * shape for but no way to create. One per wallet: a second "what I am aiming at" is not a feature,
 * it is a question nobody can answer.
 */
export function useTargetAllocation(): SavedTarget {
  const auth = useAuth();
  const qc = useQueryClient();
  const key = ["automation", auth.signedInAs ?? ""];

  const rules = useQuery({
    queryKey: key,
    queryFn: async () => (await apiGet<{ rules: RuleDTO[] }>("/api/automation")).rules,
    enabled: auth.isSignedIn,
    staleTime: 60_000,
  });

  const rule = (rules.data ?? []).find((r) => r.type === "drift-alert" && r.status === "active") ?? null;

  const save = useMutation({
    mutationFn: async (allocations: Allocation[]) => {
      await auth.ensureSignedIn();
      // One target per wallet: replace rather than pile up.
      const existing = (await apiGet<{ rules: RuleDTO[] }>("/api/automation")).rules.filter((r) => r.type === "drift-alert");
      for (const r of existing) await apiPatch("/api/automation", { id: r.id, action: "delete" }).catch(() => undefined);
      await apiPost("/api/automation", { type: "drift-alert", allocations, thresholdBps: DEFAULT_THRESHOLD_BPS });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automation"] }),
  });

  const clear = useMutation({
    mutationFn: async () => {
      if (!rule) return;
      await auth.ensureSignedIn();
      await apiPatch("/api/automation", { id: rule.id, action: "delete" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automation"] }),
  });

  return {
    rule,
    allocations: rule?.config.allocations ?? null,
    thresholdBps: rule?.config.thresholdBps ?? DEFAULT_THRESHOLD_BPS,
    signedIn: auth.isSignedIn,
    save: async (a) => void (await save.mutateAsync(a)),
    clear: async () => void (await clear.mutateAsync()),
    saving: save.isPending || clear.isPending,
  };
}

/**
 * Turns the stock side of a snapshot into weights that add to exactly 100%. USDC is left out on
 * purpose: cash is what rebalancing moves through, not something to hold a target share of.
 */
export function allocationsFromSnapshot(snapshot: PortfolioSnapshot): Allocation[] {
  const priced = snapshot.holdings.filter((h) => h.marketValueUsd > 0);
  const total = priced.reduce((sum, h) => sum + h.marketValueUsd, 0);
  if (total <= 0 || priced.length === 0) return [];
  const out: Allocation[] = priced.map((h) => ({ assetAddress: h.assetAddress, weightBps: Math.max(1, Math.round((h.marketValueUsd / total) * TOTAL_BPS)) }));
  // Rounding has to land somewhere; the largest leg absorbs it, as it does everywhere else here.
  const drift = TOTAL_BPS - out.reduce((s, a) => s + a.weightBps, 0);
  if (drift !== 0) {
    const biggest = out.reduce((best, a, i) => (a.weightBps > out[best]!.weightBps ? i : best), 0);
    out[biggest]!.weightBps += drift;
  }
  return out;
}

/** Save / replace / clear, shown under the drift table. */
export function TargetControls({
  snapshot,
  target,
  saved,
}: {
  snapshot: PortfolioSnapshot;
  target?: { id: string; name: string; allocations: Allocation[] };
  saved: SavedTarget;
}) {
  const current = allocationsFromSnapshot(snapshot);
  const isSavedTarget = target?.id === MY_TARGET_ID;

  if (!saved.signedIn) {
    return (
      <div className="px-4 py-3 border-t border-line flex flex-wrap items-center gap-3">
        <p className="text-[12px] text-ink-secondary flex-1 min-w-[220px]">Sign in to save a target mix. It is stored against your wallet and nothing runs without you.</p>
        <Button size="sm" variant="secondary" loading={saved.saving} onClick={() => void saved.save(current)} disabled={current.length === 0}>
          <Bookmark size={13} strokeWidth={1.75} /> Save this mix as my target
        </Button>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 border-t border-line flex flex-wrap items-center gap-2">
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
      <span className="text-[11px] text-ink-muted">{`Flagged once any stock is ${saved.thresholdBps / 100}% away from it.`}</span>
    </div>
  );
}

/** Worst drift across the target, in basis points; null when there is nothing to compare. */
export function maxDriftBps(snapshot: PortfolioSnapshot, allocations: Allocation[] | null): number | null {
  if (!allocations || allocations.length === 0) return null;
  const stockValue = snapshot.holdings.reduce((sum, h) => sum + h.marketValueUsd, 0);
  if (stockValue <= 0) return null;
  let worst = 0;
  for (const a of allocations) {
    if (a.assetAddress === "USDC") continue;
    const held = snapshot.holdings.find((h) => h.assetAddress.toLowerCase() === String(a.assetAddress).toLowerCase());
    const currentBps = held ? Math.round((held.marketValueUsd / stockValue) * TOTAL_BPS) : 0;
    worst = Math.max(worst, Math.abs(currentBps - a.weightBps));
  }
  return worst;
}
