import { describe, expect, it } from "vitest";
import { classifyFreshness, isUsMarketOpen, secondsSinceUsMarketClose, secondsSinceUsMarketOpen } from "./market-hours";

const H = 3600;
/** New York wall-clock instants, written in UTC (EDT = UTC-4 in September, EST = UTC-5 in December). */
const SAT_SEP_12_2026_18_15_UTC = new Date("2026-09-12T22:15:00Z"); // Saturday 18:15 New York
const FRI_SEP_11_2026_15_30_NY = new Date("2026-09-11T19:30:00Z"); // Friday 15:30, session open
const FRI_SEP_11_2026_16_30_NY = new Date("2026-09-11T20:30:00Z"); // Friday 16:30, just closed
const MON_SEP_14_2026_09_45_NY = new Date("2026-09-14T13:45:00Z"); // Monday 09:45, session open 15 min
const TUE_SEP_08_2026_08_00_NY = new Date("2026-09-08T12:00:00Z"); // Tuesday after Labor Day, before the open
const LABOR_DAY_2026_NOON_NY = new Date("2026-09-07T16:00:00Z");

describe("US market clock", () => {
  it("knows the session, the weekend and the holidays", () => {
    expect(isUsMarketOpen(FRI_SEP_11_2026_15_30_NY)).toBe(true);
    expect(isUsMarketOpen(FRI_SEP_11_2026_16_30_NY)).toBe(false);
    expect(isUsMarketOpen(SAT_SEP_12_2026_18_15_UTC)).toBe(false);
    expect(isUsMarketOpen(LABOR_DAY_2026_NOON_NY)).toBe(false);
    expect(isUsMarketOpen(MON_SEP_14_2026_09_45_NY)).toBe(true);
  });

  it("measures the time since the last close across a weekend and a holiday", () => {
    expect(secondsSinceUsMarketClose(FRI_SEP_11_2026_15_30_NY)).toBe(0);
    expect(secondsSinceUsMarketClose(FRI_SEP_11_2026_16_30_NY)).toBe(30 * 60);
    // Saturday 18:15 is 26 h 15 min after Friday's 16:00 close.
    expect(secondsSinceUsMarketClose(SAT_SEP_12_2026_18_15_UTC)).toBe(26 * H + 15 * 60);
    // Tuesday 08:00 after Labor Day reads back to Friday 4 September's close: 3 days and 16 hours.
    expect(secondsSinceUsMarketClose(TUE_SEP_08_2026_08_00_NY)).toBe(3 * 24 * H + 16 * H);
    expect(secondsSinceUsMarketOpen(MON_SEP_14_2026_09_45_NY)).toBe(15 * 60);
    expect(secondsSinceUsMarketOpen(SAT_SEP_12_2026_18_15_UTC)).toBeNull();
  });
});

describe("reference freshness", () => {
  const threshold = 26 * H;

  it("calls a weekend hold what it is, however long ago the last write was", () => {
    // AAPL on Saturday evening: last write 28 h ago, close 26.25 h ago. The value is Friday's close.
    expect(classifyFreshness({ ageSeconds: 28 * H, thresholdSeconds: threshold, paused: false, marketOpen: false, sinceCloseSeconds: 26.25 * H })).toBe("last-close");
    // AMZN, written 20 h ago: the same.
    expect(classifyFreshness({ ageSeconds: 20 * H, thresholdSeconds: threshold, paused: false, marketOpen: false, sinceCloseSeconds: 26.25 * H })).toBe("last-close");
  });

  it("still catches a feed that died before the close", () => {
    // Last write four days before the close: nothing about Friday is in it.
    expect(classifyFreshness({ ageSeconds: 26.25 * H + 4 * 24 * H, thresholdSeconds: threshold, paused: false, marketOpen: false, sinceCloseSeconds: 26.25 * H })).toBe("stale");
  });

  it("is live during the session and stale once a session is well under way without a write", () => {
    expect(classifyFreshness({ ageSeconds: 2 * H, thresholdSeconds: threshold, paused: false, marketOpen: true, sinceOpenSeconds: 3 * H })).toBe("live");
    expect(classifyFreshness({ ageSeconds: 40 * H, thresholdSeconds: threshold, paused: false, marketOpen: true, sinceOpenSeconds: 3 * H })).toBe("stale");
    // Fifteen minutes after Monday's open the feed may still hold Friday's close.
    expect(classifyFreshness({ ageSeconds: 65 * H, thresholdSeconds: threshold, paused: false, marketOpen: true, sinceOpenSeconds: 15 * 60 })).toBe("last-close");
  });

  it("keeps frozen above everything and live for a fresh off-hours write", () => {
    expect(classifyFreshness({ ageSeconds: 60, thresholdSeconds: threshold, paused: true, marketOpen: true })).toBe("frozen");
    expect(classifyFreshness({ ageSeconds: 60, thresholdSeconds: threshold, paused: false, marketOpen: false, sinceCloseSeconds: 5 * H })).toBe("live");
  });
});
