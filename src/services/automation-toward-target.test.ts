import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { createRule, markRun } from "./automation-service";

const OWNER = "0x78de409a6306550882328E2a67160471368387FF" as Address;
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const AAPL = "0xb200000000000000000000C2e324d24d7eEcd1fb" as Address;
const half = [
  { assetAddress: NVDA, weightBps: 5000 },
  { assetAddress: AAPL, weightBps: 5000 },
];

describe("a plan that returns to the target", () => {
  it("is a manual basket plan, never an automatic one", async () => {
    await expect(createRule(OWNER, { type: "recurring-basket", mode: "auto", allocations: half, amountUsd: 25, cadenceDays: 14, towardTarget: true })).rejects.toThrow(/cannot be automatic/);
    await expect(createRule(OWNER, { type: "recurring-buy", mode: "manual", assetAddress: NVDA, amountUsd: 25, cadenceDays: 14, towardTarget: true })).rejects.toThrow(/needs a target mix/);
    const rule = await createRule(OWNER, { type: "recurring-basket", mode: "manual", allocations: half, basketName: "Toward my target", amountUsd: 25, cadenceDays: 14, towardTarget: true });
    expect(rule.config.towardTarget).toBe(true);
    expect(rule.config.mode).toBe("manual");
  });

  /**
   * The mix was already in balance, so the run bought nothing — and that is the run doing its
   * job, not failing. The date moves on and the history says why. An ordinary plan that bought
   * nothing stays due, as before.
   */
  it("moves to the next date when the run finds the mix in balance", async () => {
    const rule = await createRule(OWNER, { type: "recurring-basket", mode: "manual", allocations: half, basketName: "Toward my target", amountUsd: 25, cadenceDays: 14, towardTarget: true });
    const before = rule.nextRunAt!;
    const after = await markRun(OWNER, rule.id, { ok: true, inBalance: true, spentUsd: 0, legs: [] });
    expect(after!.nextRunAt!).toBeGreaterThan(before);
    expect(after!.config.history?.[0]?.ok).toBe(true);
    expect(after!.config.history?.[0]?.note).toMatch(/in balance/i);

    const plain = await createRule(OWNER, { type: "recurring-basket", mode: "manual", allocations: half, basketName: "Plain", amountUsd: 25, cadenceDays: 14 });
    const stuck = await markRun(OWNER, plain.id, { ok: true, inBalance: true, spentUsd: 0, legs: [] });
    expect(stuck!.nextRunAt).toBe(plain.nextRunAt);
    expect(stuck!.config.history?.[0]?.ok).toBe(false);
  });
});
