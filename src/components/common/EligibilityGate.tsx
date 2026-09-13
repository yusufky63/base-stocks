"use client";

import Link from "next/link";
import { useCallback, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { Globe } from "lucide-react";
import { useRegion } from "@/hooks/queries";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/primitives";
import { EligibilityAttestation } from "./EligibilityAttestation";
import { classifyDismissal, shouldAsk, type Dismissal } from "./eligibility-dismissal";

/**
 * The eligibility question, asked once on arrival rather than at the moment of a trade.
 *
 * Coinbase Tokenized Stocks are offered only to eligible persons outside the United States. The
 * inline notice on each trading surface still guards the actions, but a visitor from a restricted
 * region should not have to reach the Buy button to learn that: the app says so first, and asks
 * them to answer.
 *
 * Answering "just browsing" closes it and leaves every execution route shut, which is the honest
 * default. The dismissal is remembered for the browser session: an earlier version asked again on
 * every page, which put a focus-trapping modal in front of someone who had already answered each
 * time they clicked a link. It asks once more only when a trading surface opens after a day has
 * passed. Prices, charts, news and Earn data stay open to everyone either way.
 */

const DISMISSED_KEY = "bstocks:eligibility-dismissed";
const DISMISSED_EVENT = "bstocks:eligibility";

function readDismissedAt(): number | null {
  try {
    const raw = sessionStorage.getItem(DISMISSED_KEY);
    const at = raw ? Number(raw) : NaN;
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

function subscribe(cb: () => void) {
  window.addEventListener(DISMISSED_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(DISMISSED_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/**
 * The dismissal as the component sees it. Time is read inside the snapshot, not in render: the clock
 * is external state like the storage entry, and React re-reads the snapshot on every render, which
 * is exactly when a dismissal that has aged past a day should start reading as "stale". The server
 * (and the hydration pass) assume "never"; the client snapshot corrects that right after mount.
 */
function useDismissal(): Dismissal {
  return useSyncExternalStore(subscribe, () => classifyDismissal(readDismissedAt(), Date.now()), () => "never");
}

export function EligibilityGate() {
  const path = usePathname();
  const region = useRegion();
  const dismissal = useDismissal();

  const data = region.data;
  // `restricted` is the field that already accounts for the mode. Reading blockedCountry and the
  // cookie separately meant a visitor carrying an attestation from before the switch to block mode
  // saw no modal at all while every execution route still refused them: blocked, and never told why.
  const open = !!data?.restricted && shouldAsk(dismissal, path);
  const attest = data?.mode === "attest";

  const close = useCallback(() => {
    try {
      sessionStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {
      /* private mode: the modal simply closes for this render and may return on the next page */
    }
    window.dispatchEvent(new Event(DISMISSED_EVENT));
  }, []);

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
          <EligibilityAttestation
            layout="boxed"
            onConfirmed={close}
            secondary={
              <Button variant="secondary" onClick={close}>
                I&apos;m just browsing
              </Button>
            }
          />
        ) : (
          <>
            <p className="text-ink-secondary leading-relaxed">You can browse prices, charts, news and Earn data here, but orders and deposits cannot be placed from your location.</p>
            <Button variant="secondary" onClick={close}>
              Continue browsing
            </Button>
          </>
        )}

        <Link href="/how-it-works#faq" className="text-primary font-medium text-[13px] self-start" onClick={close}>
          Who can trade here →
        </Link>
      </div>
    </Sheet>
  );
}
