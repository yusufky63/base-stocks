/**
 * US equity regular session (NYSE/Nasdaq): Mon–Fri 09:30–16:00 America/New_York.
 * Holidays are not modelled; a closed-holiday feed simply reads as "last close" a little longer.
 * Used only for labelling reference-price freshness (spec: feeds hold the last close off-hours).
 */
const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit" });

export function isUsMarketOpen(at: Date = new Date()): boolean {
  const parts = fmt.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = get("weekday");
  if (weekday === "Sat" || weekday === "Sun") return false;
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const minutes = hour * 60 + minute;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

export type ReferenceFreshness = "live" | "last-close" | "stale" | "frozen";

/**
 * Classify a total-return Chainlink feed reading (spec "Price feeds"):
 * - frozen: the oracle registry pause flag is set (corporate action) — price held, do not settle against it
 * - stale: older than the heartbeat bound even though it should be updating
 * - last-close: market closed, feed legitimately holding the last close
 * - live: updating within the deviation/heartbeat window during market hours
 */
export function classifyFreshness(input: { ageSeconds: number; thresholdSeconds: number; paused: boolean; marketOpen: boolean }): ReferenceFreshness {
  if (input.paused) return "frozen";
  if (input.ageSeconds > input.thresholdSeconds) return "stale";
  if (!input.marketOpen && input.ageSeconds > 30 * 60) return "last-close";
  return "live";
}
