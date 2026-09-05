"use client";

import { useState } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/primitives";
import { printCards, type PrintCard } from "@/lib/print-cards";

/**
 * "Print cards": one QR card per link, through the browser's own print dialog. The QR code is
 * drawn in this tab and the sheet is written into a new window; no server is involved, because
 * a claim link is the gift and never leaves the giver's browser on purpose.
 */
/** `cards` may be a function: it runs on the click, so dates and other now-dependent text are computed when the sheet is made, not on every render. */
export function PrintCardsButton({ cards, count, label, size = "md", variant = "secondary", full, className }: { cards: PrintCard[] | (() => PrintCard[]); count?: number; label?: string; size?: "sm" | "md"; variant?: "secondary" | "ghost"; full?: boolean; className?: string }) {
  const [state, setState] = useState<"idle" | "working" | "blocked">("idle");
  const n = count ?? (typeof cards === "function" ? 1 : cards.length);
  const onClick = async () => {
    setState("working");
    const ok = await printCards(typeof cards === "function" ? cards() : cards);
    setState(ok ? "idle" : "blocked");
  };
  const text = label ?? (n > 1 ? `Print ${n} cards` : "Print a card");
  return (
    <span className={className}>
      <Button size={size} variant={variant} full={full} loading={state === "working"} onClick={() => void onClick()} disabled={n === 0}>
        <Printer size={size === "sm" ? 13 : 14} strokeWidth={1.75} /> {text}
      </Button>
      {state === "blocked" && <span className="block mt-1 text-[12px] text-warning-fg">The browser blocked the print window. Allow pop-ups for this site and try again.</span>}
    </span>
  );
}
