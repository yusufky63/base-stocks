"use client";

import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiPost, type RegionResponse } from "@/lib/client-api";
import { qk } from "@/hooks/queries";
import { Button, cx } from "@/components/ui/primitives";

/**
 * The self-certification form, shared by the arrival modal and the inline notice on trading
 * surfaces so the wording, the cookie note and the failure message cannot drift apart.
 *
 * Confirming posts to /api/region and invalidates the region query, which is what flips every
 * trading surface from "unavailable" to live; `onConfirmed` lets the modal close itself after.
 */
export function EligibilityAttestation({ onConfirmed, secondary, layout = "inline", className }: { onConfirmed?: () => void; secondary?: ReactNode; layout?: "inline" | "boxed"; className?: string }) {
  const qc = useQueryClient();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost<RegionResponse>("/api/region", { confirm: true });
      await qc.invalidateQueries({ queryKey: qk.region });
      onConfirmed?.();
    } catch {
      setError("Could not save your confirmation. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const boxed = layout === "boxed";
  return (
    <div className={cx("flex flex-col", boxed ? "gap-4" : "gap-2", className)}>
      <label className={cx("flex items-start cursor-pointer", boxed ? "gap-2.5 border border-line rounded-[8px] p-3" : "gap-2")}>
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-primary)] shrink-0" />
        <span className="text-ink leading-relaxed">I confirm that I am not a US person and that I am eligible to hold and trade Coinbase Tokenized Stocks under the issuer&apos;s terms.</span>
      </label>
      <div className={cx("flex flex-wrap items-center", boxed ? "gap-2" : "gap-3")}>
        <Button size={boxed ? "md" : "sm"} disabled={!checked} loading={busy} onClick={() => void confirm()}>
          Confirm and continue
        </Button>
        {secondary}
        {!boxed && <span className="text-[11px] text-ink-muted">Stored as a cookie on this device for 30 days. No personal data is recorded.</span>}
      </div>
      {boxed && (
        <p className="text-[12px] text-ink-muted leading-relaxed">
          Your confirmation is stored as a cookie on this device for 30 days. Nothing about you is recorded. Without it, prices, charts, news and Earn data stay open, but orders and deposits cannot be placed.
        </p>
      )}
      {error && <p className="text-danger-fg text-[13px]">{error}</p>}
    </div>
  );
}
