import type { PortfolioExecution, PortfolioExecutionStatus, PortfolioExecutionStep, PortfolioPlan } from "@/domain/portfolio";
import type { Address } from "viem";

/**
 * Pure state transitions for multi-leg portfolio execution (spec §25).
 * Execution is not assumed atomic: each leg carries its own status and the aggregate
 * status is derived, never rolled back to "nothing happened".
 */
export function deriveStatus(steps: PortfolioExecutionStep[]): PortfolioExecutionStatus {
  if (steps.length === 0) return "READY";
  const count = (s: PortfolioExecutionStep["status"]) => steps.filter((x) => x.status === s).length;
  const confirmed = count("confirmed");
  const failed = count("failed");
  const submitted = count("submitted");
  const quoted = count("quoted");
  const pending = count("pending");

  if (confirmed === steps.length) return "COMPLETE";
  if (submitted > 0) return "EXECUTING";
  if (failed === steps.length) return "FAILED";
  if (confirmed > 0 && failed > 0 && pending === 0 && quoted === 0) return "PARTIALLY_FILLED";
  if (confirmed > 0 && (pending > 0 || quoted > 0)) return "EXECUTING";
  if (failed > 0 && confirmed === 0 && pending === 0 && quoted === 0) return "FAILED";
  if (quoted > 0) return "AWAITING_USER";
  return "READY";
}

/** Legs that could not even be quoted are left out: a step that is known to fail is not a step. */
export function runnableLegs(plan: Pick<PortfolioPlan, "legs">): PortfolioPlan["legs"] {
  return plan.legs.filter((l) => !l.quoteError);
}

export function createExecution(owner: Address, plan: PortfolioPlan, id = newId("exec")): PortfolioExecution {
  const now = Date.now();
  const legs = runnableLegs(plan);
  return {
    id,
    owner,
    status: "READY",
    totalUsd: legs.reduce((s, l) => s + l.targetUsd, 0),
    steps: legs.map((leg) => ({
      id: newId("step"),
      assetAddress: leg.assetAddress,
      symbol: leg.symbol,
      side: "buy" as const,
      targetUsd: leg.targetUsd,
      sellAmountUsdc: leg.sellAmountUsdc,
      provider: leg.provider,
      status: "pending",
    })),
    createdAt: now,
    updatedAt: now,
  };
}

export interface CustomLeg {
  side: "buy" | "sell";
  assetAddress: Address;
  symbol: string;
  targetUsd: number;
  /** USDC base units for buys, B20 raw units for sells. */
  amount: bigint;
}

/** Execution from arbitrary legs (rebalance): sells run before buys so USDC is available. */
export function createCustomExecution(owner: Address, legs: CustomLeg[], id = newId("exec")): PortfolioExecution {
  const now = Date.now();
  const ordered = [...legs.filter((l) => l.side === "sell"), ...legs.filter((l) => l.side === "buy")];
  return {
    id,
    owner,
    status: "READY",
    totalUsd: legs.reduce((s, l) => s + Math.abs(l.targetUsd), 0),
    steps: ordered.map((l) => ({
      id: newId("step"),
      assetAddress: l.assetAddress,
      symbol: l.symbol,
      side: l.side,
      targetUsd: Math.abs(l.targetUsd),
      sellAmountUsdc: l.side === "buy" ? l.amount.toString() : "0",
      sellAmount: l.side === "sell" ? l.amount.toString() : undefined,
      status: "pending",
    })),
    createdAt: now,
    updatedAt: now,
  };
}

export function updateStep(exec: PortfolioExecution, stepId: string, patch: Partial<PortfolioExecutionStep>): PortfolioExecution {
  const steps = exec.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s));
  return { ...exec, steps, status: deriveStatus(steps), updatedAt: Date.now() };
}

/** Reset failed legs to pending so they can be retried; confirmed legs are never touched. */
export function resetFailedSteps(exec: PortfolioExecution, stepIds?: string[]): PortfolioExecution {
  const steps = exec.steps.map((s) =>
    s.status === "failed" && (!stepIds || stepIds.includes(s.id)) ? { ...s, status: "pending" as const, errorCode: undefined, errorMessage: undefined, txHash: undefined } : s,
  );
  return { ...exec, steps, status: deriveStatus(steps), updatedAt: Date.now() };
}

export function summarize(exec: PortfolioExecution): { completed: number; total: number; failedSymbols: string[] } {
  return {
    completed: exec.steps.filter((s) => s.status === "confirmed").length,
    total: exec.steps.length,
    failedSymbols: exec.steps.filter((s) => s.status === "failed").map((s) => s.symbol),
  };
}

export function newId(prefix: string): string {
  const rand = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "").slice(0, 12) : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
