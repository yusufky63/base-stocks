"use client";

import { useSyncExternalStore } from "react";
import { nextSessionBoundary, untilLabel } from "@/lib/market-hours";
import { cx } from "@/components/ui/primitives";

/** The current minute, as an external store: ticks once a minute, and is unknown on the server. */
const MINUTE = 60_000;
function subscribe(onChange: () => void) {
  const id = setInterval(onChange, MINUTE);
  return () => clearInterval(id);
}
const minuteNow = () => Math.floor(Date.now() / MINUTE);
const minuteOnServer = () => null;

/**
 * The one fact behind most weekend questions: the chain trades 24/7, the NYSE does not. Off
 * hours, prices come from the pools and the stock's own price holds its last close; this says so
 * in one short line on the Markets page and counts down to the next open. Pure arithmetic on
 * the client, refreshed each minute; nothing is fetched, and nothing renders until the client
 * knows the time.
 */
export function MarketClock({ className }: { className?: string }) {
  const minute = useSyncExternalStore(subscribe, minuteNow, minuteOnServer);
  if (minute === null) return null;
  const now = minute * MINUTE;
  const b = nextSessionBoundary(new Date(now));
  const until = untilLabel(b.at.getTime() - now);
  const when = b.at.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
  return (
    <span
      className={cx("inline-flex items-center gap-1.5", className)}
      title={b.open ? `NYSE regular session is open; it closes at ${when} ET. Pool prices and the stock's own price both move.` : `NYSE is closed until ${when} ET. Tokenized stocks still trade on Base from the pools; the stock's own price holds its last close.`}
    >
      <span className={cx("h-1.5 w-1.5 rounded-full", b.open ? "bg-positive-fg" : "bg-ink-muted")} aria-hidden />
      <span>{b.open ? `NYSE open · closes in ${until}` : `NYSE closed · opens ${when} ET`}</span>
    </span>
  );
}
