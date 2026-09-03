import { describe, expect, it } from "vitest";
import { createExecution, deriveStatus, resetFailedSteps, summarize, updateStep } from "./portfolio-execution";
import type { PortfolioPlan } from "@/domain/portfolio";

const plan: PortfolioPlan = {
  totalUsd: 100,
  keepUsdcUsd: 0,
  keepUsdcBps: 0,
  minTradeUsd: 1,
  warnings: [],
  legs: [
    { assetAddress: "0xb20000000000000000000078ee7ce2fE4908108C", symbol: "NVDAc", weightBps: 5000, targetUsd: 50, sellAmountUsdc: "50000000" },
    { assetAddress: "0xB200000000000000000000Ab99cFa739E253872B", symbol: "MSFTc", weightBps: 2500, targetUsd: 25, sellAmountUsdc: "25000000" },
    { assetAddress: "0xb200000000000000000000d9192b6B456483C2E8", symbol: "AMZNc", weightBps: 2500, targetUsd: 25, sellAmountUsdc: "25000000" },
  ],
};

describe("portfolio execution state machine", () => {
  it("starts READY with pending steps", () => {
    const e = createExecution("0x0000000000000000000000000000000000000001", plan);
    expect(e.status).toBe("READY");
    expect(e.steps).toHaveLength(3);
  });

  it("moves to EXECUTING when a leg is submitted and COMPLETE when all confirm", () => {
    let e = createExecution("0x0000000000000000000000000000000000000001", plan);
    e = updateStep(e, e.steps[0]!.id, { status: "submitted", txHash: "0x01" as `0x${string}` });
    expect(e.status).toBe("EXECUTING");
    for (const s of e.steps) e = updateStep(e, s.id, { status: "confirmed" });
    expect(e.status).toBe("COMPLETE");
  });

  it("represents partial fills honestly and allows retry of the failed leg only", () => {
    let e = createExecution("0x0000000000000000000000000000000000000001", plan);
    e = updateStep(e, e.steps[0]!.id, { status: "confirmed" });
    e = updateStep(e, e.steps[1]!.id, { status: "confirmed" });
    e = updateStep(e, e.steps[2]!.id, { status: "failed", errorCode: "ROUTE_UNAVAILABLE" });
    expect(e.status).toBe("PARTIALLY_FILLED");
    expect(summarize(e)).toEqual({ completed: 2, total: 3, failedSymbols: ["AMZNc"] });

    const retried = resetFailedSteps(e);
    expect(retried.steps[2]!.status).toBe("pending");
    expect(retried.steps[0]!.status).toBe("confirmed");
    expect(retried.status).toBe("EXECUTING");
  });

  it("is FAILED only when every leg failed", () => {
    expect(deriveStatus([{ id: "a", assetAddress: "0x0000000000000000000000000000000000000001", symbol: "X", targetUsd: 1, sellAmountUsdc: "1", status: "failed" }])).toBe("FAILED");
  });
});
