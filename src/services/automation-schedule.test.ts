import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { AutomationRule } from "@/domain/community";
import { isDue, missedRuns, nextRunAfter } from "./automation-service";

const DAY = 24 * 3600_000;
const WEEK = 7 * DAY;
const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);

const rule = (over: Partial<AutomationRule> & { nextRunAt?: number } = {}): AutomationRule =>
  ({
    id: "auto_1",
    owner: "0x78de409a6306550882328E2a67160471368387FF" as Address,
    type: "recurring-buy",
    config: { amountUsd: 100, cadenceDays: 7 },
    status: "active",
    createdAt: NOW - WEEK,
    updatedAt: NOW - WEEK,
    ...over,
  }) as AutomationRule;

describe("when the next run falls due", () => {
  /**
   * The bug this replaces: the next run was anchored on the moment of confirmation, so confirming
   * three days late every week quietly turned a weekly plan into a ten-day one.
   */
  it("keeps the cadence when a run is confirmed late", () => {
    const scheduled = NOW - 3 * DAY; // it was due on Monday
    const next = nextRunAfter(scheduled, 7, NOW); // confirmed on Thursday
    expect(next).toBe(scheduled + WEEK); // still the following Monday, not Thursday + 7
    expect(next - NOW).toBe(4 * DAY);
  });

  it("keeps the cadence when a run is confirmed early", () => {
    const scheduled = NOW + 2 * DAY;
    expect(nextRunAfter(scheduled, 7, NOW)).toBe(scheduled + WEEK);
  });

  /** Two months away should leave one run waiting, not eight queued up. */
  it("catches up past a long absence instead of stacking runs", () => {
    const scheduled = NOW - 60 * DAY;
    const next = nextRunAfter(scheduled, 7, NOW);
    expect(next).toBeGreaterThan(NOW);
    expect(next - NOW).toBeLessThanOrEqual(WEEK);
    // and it stays on the original weekday
    expect((next - scheduled) % WEEK).toBe(0);
  });

  it("never schedules into the past, whatever it is given", () => {
    for (const cadence of [1, 7, 30, 90]) {
      for (const offset of [-365 * DAY, -DAY, 0, DAY]) {
        expect(nextRunAfter(NOW + offset, cadence, NOW)).toBeGreaterThan(NOW);
      }
    }
  });

  it("starts from now for a rule that has never run", () => {
    expect(nextRunAfter(undefined, 7, NOW)).toBe(NOW + WEEK);
  });

  it("does not divide by a zero cadence", () => {
    expect(nextRunAfter(NOW - DAY, 0, NOW)).toBeGreaterThan(NOW);
  });
});

describe("runs that went by unconfirmed", () => {
  it("counts none while the plan is not yet due", () => {
    expect(missedRuns(rule({ nextRunAt: NOW + DAY }), NOW)).toBe(0);
  });

  it("counts the run that is due right now as one", () => {
    expect(missedRuns(rule({ nextRunAt: NOW - 1 }), NOW)).toBe(1);
    expect(missedRuns(rule({ nextRunAt: NOW - 3 * DAY }), NOW)).toBe(1);
  });

  it("counts each whole cadence that passed", () => {
    expect(missedRuns(rule({ nextRunAt: NOW - WEEK }), NOW)).toBe(2);
    expect(missedRuns(rule({ nextRunAt: NOW - 3 * WEEK }), NOW)).toBe(4);
  });

  it("says nothing about a paused plan", () => {
    expect(missedRuns(rule({ nextRunAt: NOW - 3 * WEEK, status: "paused" }), NOW)).toBe(0);
    expect(isDue(rule({ nextRunAt: NOW - WEEK, status: "paused" }), NOW)).toBe(false);
  });

  it("says nothing about a drift alert, which has no schedule", () => {
    expect(isDue(rule({ type: "drift-alert", nextRunAt: undefined }), NOW)).toBe(false);
    expect(missedRuns(rule({ type: "drift-alert", nextRunAt: undefined }), NOW)).toBe(0);
  });
});
