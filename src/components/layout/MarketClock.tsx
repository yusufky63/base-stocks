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
 * hours, prices come from the pools and the reference feed holds the last close; this says so
 * at the top of every page and counts down to the next open. Pure arithmetic on the client,
 * refreshed each minute; nothing is fetched.
 */
export function MarketClock({ className }: { className?: string }) {
  const minute = useSyncExternalStore(subscribe, minuteNow, minuteOnServer);
  // The server has no idea what time the reader's "now" is; the cell keeps its width until the client knows.
  if (minute === null) return <span className={cx("inline-flex items-center px-3 h-8 border-r border-line text-ink-muted", className)} aria-hidden />;
  const now = minute * MINUTE;
  const b = nextSessionBoundary(new Date(now));
  const until = untilLabel(b.at.getTime() - now);
  const when = b.at.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
  return (
    <span
      className={cx("inline-flex items-center gap-2 px-3 h-8 border-r border-line shrink-0 whitespace-nowrap", b.open ? "text-ink" : "text-ink-secondary", className)}
      title={b.open ? `NYSE regular session is open; it closes at ${when} ET. Pool prices and the stock's own price both move.` : `NYSE is closed until ${when} ET. Tokenized stocks still trade on Base from the pools; the stock's own price holds its last close.`}
    >
      <span className={cx("h-1.5 w-1.5 rounded-full", b.open ? "bg-positive-fg" : "bg-ink-muted")} aria-hidden />
      <span className="font-medium">{b.open ? "NYSE open" : "NYSE closed"}</span>
      <span className="text-ink-muted normal-case tracking-normal">{b.open ? `closes in ${until}` : `pool prices · opens ${when} ET (${until})`}</span>
    </span>
  );
}
