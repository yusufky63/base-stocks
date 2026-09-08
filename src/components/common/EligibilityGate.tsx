"use client";

import Link from "next/link";
import { useState } from "react";
import { Globe } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { apiPost, type RegionResponse } from "@/lib/client-api";
import { qk, useRegion } from "@/hooks/queries";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/primitives";

/**
 * The eligibility question, asked once on arrival rather than at the moment of a trade.
 *
 * Coinbase Tokenized Stocks are offered only to eligible persons outside the United States. The
 * inline notice on each trading surface still guards the actions, but a visitor from a restricted
 * region should not have to reach the Buy button to learn that: the app says so first, and asks
 * them to answer.
 *
 * Answering "just browsing" closes it for the session and leaves every execution route shut, which
 * is the honest default. Prices, charts, news and Earn data stay open to everyone either way.
 */
export function EligibilityGate() {
  const qc = useQueryClient();
  const region = useRegion();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Not remembered across pages. The shell keys this component by pathname, so closing it clears
  // the current page and the next one asks again: somebody being refused should be told on every
  // page they land on, not once and then silently.
  const [dismissed, setDismissed] = useState(false);

  const data = region.data;
  // `restricted` is the field that already accounts for the mode. Reading blockedCountry and the
  // cookie separately meant a visitor carrying an attestation from before the switch to block mode
  // saw no modal at all while every execution route still refused them: blocked, and never told why.
  const open = !dismissed && !!data?.restricted;
  const attest = data?.mode === "attest";

  const close = () => setDismissed(true);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost<RegionResponse>("/api/region", { confirm: true });
      await qc.invalidateQueries({ queryKey: qk.region });
      close();
    } catch {
      setError("Could not save your confirmation. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title={
        <span className="inline-flex items-center gap-2">
          <Globe size={18} strokeWidth={1.75} className="text-warning-fg" />
          {attest ? "Before you trade" : "Trading is not available in your region"}
        </span>
      }
    >
      <div className="flex flex-col gap-4 text-[14px]">
        <p className="text-ink-secondary leading-relaxed">
          Coinbase Tokenized Stocks are offered only to eligible persons outside the United States.
          {data?.country ? ` This connection looks like it comes from ${data.country}.` : ""}
        </p>

        {attest ? (
          <>
            <label className="flex items-start gap-2.5 cursor-pointer border border-line rounded-[8px] p-3">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-primary)] shrink-0" />
              <span className="text-ink leading-relaxed">I confirm that I am not a US person and that I am eligible to hold and trade Coinbase Tokenized Stocks under the issuer&apos;s terms.</span>
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={!checked} loading={busy} onClick={() => void confirm()}>
                Confirm and continue
              </Button>
              <Button variant="secondary" onClick={close}>
                I&apos;m just browsing
              </Button>
            </div>

            <p className="text-[12px] text-ink-muted leading-relaxed">
              Your confirmation is stored as a cookie on this device for 30 days. Nothing about you is recorded. Without it, prices, charts, news and Earn data stay open, but orders and deposits cannot be
              placed.
            </p>
          </>
        ) : (
          <>
            <p className="text-ink-secondary leading-relaxed">You can browse prices, charts, news and Earn data here, but orders and deposits cannot be placed from your location.</p>
            <Button variant="secondary" onClick={close}>
              Continue browsing
            </Button>
          </>
        )}

        {error && <p className="text-danger-fg text-[13px]">{error}</p>}

        <Link href="/how-it-works#faq" className="text-primary font-medium text-[13px] self-start" onClick={close}>
          Who can trade here →
        </Link>
      </div>
    </Sheet>
  );
}
