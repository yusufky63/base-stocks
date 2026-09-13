/**
 * US equity regular session (NYSE/Nasdaq): Mon–Fri 09:30–16:00 America/New_York, minus the
 * exchange holidays. Used for labelling reference-price freshness (spec: feeds hold the last
 * close off-hours) and for the deviation gate that decides whether a pool price is the headline.
 *
 * Early closes (the day after Thanksgiving, Christmas Eve) are not modelled; on those afternoons
 * a feed reads as "live" for three hours longer than it strictly is.
 */
const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

/** NYSE full-day closures, as published by the exchange. Extend each December. */
export const US_MARKET_HOLIDAYS = new Set<string>([
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

interface NyTime {
  weekday: string;
  date: string;
  /** Minutes since midnight, New York. */
  minutes: number;
}

function nyTime(at: Date): NyTime {
  const parts = fmt.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { weekday: get("weekday"), date: `${get("year")}-${get("month")}-${get("day")}`, minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
}

function isTradingDay(t: NyTime): boolean {
  return t.weekday !== "Sat" && t.weekday !== "Sun" && !US_MARKET_HOLIDAYS.has(t.date);
}

export function isUsMarketOpen(at: Date = new Date()): boolean {
  const t = nyTime(at);
  return isTradingDay(t) && t.minutes >= OPEN_MIN && t.minutes < CLOSE_MIN;
}

/**
 * Seconds since the most recent regular-session close before `at` (0 while the session is open).
 * Walked back a day at a time in New York time, so a Sunday reads back to Friday's close and a
 * Tuesday after a Monday holiday reads back to the previous Friday.
 */
export function secondsSinceUsMarketClose(at: Date = new Date()): number {
  const t = nyTime(at);
  if (isTradingDay(t) && t.minutes >= OPEN_MIN && t.minutes < CLOSE_MIN) return 0;
  // Minutes from the last close: today's close if it already happened, else walk back to the last trading day.
  let minutes = isTradingDay(t) && t.minutes >= CLOSE_MIN ? t.minutes - CLOSE_MIN : t.minutes + (24 * 60 - CLOSE_MIN);
  if (!(isTradingDay(t) && t.minutes >= CLOSE_MIN)) {
    let probe = new Date(at.getTime() - t.minutes * 60_000 - 12 * 3600_000); // noon the day before, New York
    let guard = 0;
    while (!isTradingDay(nyTime(probe)) && guard < 14) {
      minutes += 24 * 60;
      probe = new Date(probe.getTime() - 24 * 3600_000);
      guard += 1;
    }
  }
  return minutes * 60;
}

/** Seconds since today's open, or null when the session is not open. */
export function secondsSinceUsMarketOpen(at: Date = new Date()): number | null {
  const t = nyTime(at);
  if (!isTradingDay(t) || t.minutes < OPEN_MIN || t.minutes >= CLOSE_MIN) return null;
  return (t.minutes - OPEN_MIN) * 60;
}

export type ReferenceFreshness = "live" | "last-close" | "stale" | "frozen";

/** The first hour of a session: a feed that has not moved since the close is still holding the close, not broken. */
const OPENING_GRACE_S = 3600;

/**
 * Classify a total-return Chainlink feed reading (spec "Price feeds"):
 * - frozen: the oracle registry pause flag is set (corporate action) — price held, do not settle against it
 * - stale: older than the heartbeat bound while it should have been updating
 * - last-close: market closed, feed legitimately holding the last close
 * - live: updating within the deviation/heartbeat window during market hours
 *
 * Off-hours the feed's last write may legitimately predate the close by up to one heartbeat (it
 * writes on a 0.5% move or every 24 h), and it stays correct all weekend regardless of when that
 * write was. So off-hours a reading is stale only when it is older than the close plus the
 * heartbeat bound, not when it is older than the bound alone: on a Saturday every feed used to
 * turn "stale" 26 hours after its last write, while its value was still exactly Friday's close.
 */
export function classifyFreshness(input: { ageSeconds: number; thresholdSeconds: number; paused: boolean; marketOpen: boolean; sinceCloseSeconds?: number; sinceOpenSeconds?: number | null }): ReferenceFreshness {
  if (input.paused) return "frozen";
  if (input.marketOpen) {
    if (input.ageSeconds <= input.thresholdSeconds) return "live";
    // Right after the open the feed may still hold the close; only a session well under way makes the age a fault.
    const sinceOpen = input.sinceOpenSeconds ?? null;
    return sinceOpen !== null && sinceOpen < OPENING_GRACE_S ? "last-close" : "stale";
  }
  const sinceClose = input.sinceCloseSeconds ?? 0;
  if (input.ageSeconds > sinceClose + input.thresholdSeconds) return "stale";
  return input.ageSeconds > 30 * 60 ? "last-close" : "live";
}
