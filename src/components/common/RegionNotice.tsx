"use client";

import Link from "next/link";
import { useState } from "react";
import { Globe } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { apiPost, type RegionResponse } from "@/lib/client-api";
import { qk } from "@/hooks/queries";
import { Button, cx } from "@/components/ui/primitives";

/**
 * Shown instead of trade actions when the hosting provider's country header is in GEOBLOCK_COUNTRIES.
 * Coinbase Tokenized Stocks are offered only to eligible persons outside the United States. In
 * "attest" mode the visitor can self-certify eligibility (cookie, 30 days); in "block" mode the
 * execution routes stay closed.
 */
export function RegionNotice({ region, compact = false, className }: { region: RegionResponse; compact?: boolean; className?: string }) {
  const qc = useQueryClient();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attest = region.mode === "attest";
  const country = region.country;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost<RegionResponse>("/api/region", { confirm: true });
      await qc.invalidateQueries({ queryKey: qk.region });
    } catch {
      setError("Could not save your confirmation. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="status" className={cx("border border-warning-fg/50 rounded-[8px] px-3 py-3 text-[13px] flex gap-2.5", className)}>
      <Globe size={16} strokeWidth={1.75} className="text-warning-fg shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1 flex flex-col gap-2">
        <div>
          <div className="font-medium">{attest ? "Eligibility check" : "Trading is not available in your region"}{country ? ` · connection from ${country}` : ""}</div>
          {!compact && (
            <p className="text-ink-secondary mt-0.5">
              Coinbase Tokenized Stocks are offered only to eligible persons outside the United States.{" "}
              {attest ? "If you are not a US person and are eligible under the issuer's terms, confirm below to trade. Otherwise you can keep browsing prices, charts and news." : "You can browse prices, charts, news and Earn data here, but orders and deposits cannot be placed from your location."}
            </p>
          )}
        </div>
        {attest && (
          <>
            <label className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]" />
              <span className="text-ink">I confirm that I am not a US person and that I am eligible to hold and trade Coinbase Tokenized Stocks under the issuer&apos;s terms.</span>
            </label>
            <div className="flex items-center gap-3 flex-wrap">
              <Button size="sm" disabled={!checked} loading={busy} onClick={confirm}>
                Confirm and continue
              </Button>
              <span className="text-[11px] text-ink-muted">Stored as a cookie on this device for 30 days. No personal data is recorded.</span>
            </div>
            {error && <p className="text-danger-fg">{error}</p>}
          </>
        )}
        <Link href="/how-it-works" className="text-primary font-medium self-start">
          Who can trade →
        </Link>
      </div>
    </div>
  );
}
