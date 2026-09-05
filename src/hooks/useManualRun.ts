"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { parseUnits, type Address } from "viem";
import { TOTAL_BPS } from "@/domain/portfolio";
import { apiPatch, apiPost, ApiError, type AutomationRuleDTO, type PlanResponse } from "@/lib/client-api";
import { USDC_DECIMALS } from "@/config/chain";
import { humanizeError } from "@/lib/errors";
import { useAutomation } from "./useAutomation";
import { usePortfolioExecution } from "./usePortfolioExecution";

/**
 * A manual (confirm-each-run) plan run: the server builds the legs the same way Build does —
 * names that cannot be bought today are deferred with a reason — the wallet confirms each leg, and
 * the plan advances to its next date only if something was actually bought.
 */
export function useManualRun() {
  const { address } = useAccount();
  const automation = useAutomation();
  const exec = usePortfolioExecution();
  const [preparing, setPreparing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (r: AutomationRuleDTO) => {
    if (!address) return;
    setPreparing(r.id);
    setError(null);
    try {
      const usd = r.config.amountUsd ?? 0;
      const allocations = r.config.allocations ?? (r.config.assetAddress ? [{ assetAddress: r.config.assetAddress, weightBps: TOTAL_BPS }] : []);
      const res = await apiPost<PlanResponse>("/api/portfolio/plan", { allocations, totalUsd: usd, quote: false, source: "automation", deferredPolicy: "reserve" });
      if (!res.ok || !res.plan) throw new ApiError("BAD_REQUEST", res.errors?.[0] ?? "The run could not be prepared.", 400);
      const legs = res.plan.legs.map((l) => ({ side: "buy" as const, assetAddress: l.assetAddress, symbol: l.symbol, targetUsd: l.targetUsd, amount: parseUnits(l.targetUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS) }));
      const deferred = res.plan.deferred ?? [];
      if (legs.length === 0) throw new ApiError("ROUTE_UNAVAILABLE", `Nothing can be bought right now: ${deferred.map((d) => `${d.symbol.replace(/c$/, "")} — ${d.reason}`).join("; ")}`, 409);
      setPreparing(null);
      const final = await exec.startLegs(legs);
      const confirmed = final?.steps.filter((s) => s.status === "confirmed") ?? [];
      const spentUsd = confirmed.reduce((s, x) => s + x.targetUsd, 0);
      await apiPatch("/api/automation", {
        id: r.id,
        action: "ran",
        summary: {
          ok: spentUsd > 0,
          spentUsd,
          txHashes: confirmed.map((s) => s.txHash).filter((h): h is `0x${string}` => !!h),
          legs: [
            ...(final?.steps ?? []).map((s) => ({ assetAddress: s.assetAddress as Address, symbol: s.symbol, spentUsd: s.status === "confirmed" ? s.targetUsd : 0, provider: s.provider, skipped: s.status === "confirmed" ? undefined : (s.errorMessage ?? s.status) })),
            ...deferred.map((d) => ({ assetAddress: d.assetAddress, symbol: d.symbol, spentUsd: 0, skipped: d.reason })),
          ],
          error: spentUsd > 0 ? undefined : (final?.steps.find((s) => s.errorMessage)?.errorMessage ?? "Nothing was bought."),
        },
      }).catch(() => undefined);
      await automation.invalidate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : humanizeError(err).message);
    } finally {
      setPreparing(null);
    }
  };

  return { ...exec, run, preparing, error, clearError: () => setError(null) };
}

export type ManualRun = ReturnType<typeof useManualRun>;
