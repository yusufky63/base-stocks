import type { Address } from "viem";
import { TOTAL_BPS, USDC_ALLOCATION_KEY, type Allocation, type PortfolioSnapshot } from "@/domain/portfolio";
import { driftRows } from "./drift";

/**
 * What a "return to target" run buys today.
 *
 * Only the legs that are under target, in proportion to how far under they are, capped at the
 * plan's amount. Sells never appear: a plan that pulls toward a mix by buying can be wrong by at
 * most the money it was given, while one that sells can exit a position on a bad day. When
 * nothing is under target the answer is null, and the caller records the run as in balance.
 *
 * Pure, so the arithmetic is testable apart from the wallet and the quote.
 */
export function towardTargetRun(snapshot: Pick<PortfolioSnapshot, "holdings" | "usdcValueUsd">, target: Allocation[], amountUsd: number): { allocations: Allocation[]; totalUsd: number } | null {
  if (amountUsd <= 0) return null;
  const buys = driftRows(snapshot, target).filter((row) => row.action === "buy" && row.assetAddress !== USDC_ALLOCATION_KEY);
  const gap = buys.reduce((s, row) => s + row.deltaUsd, 0);
  if (buys.length === 0 || gap <= 0) return null;
  const weights = buys.map((row) => ({ assetAddress: row.assetAddress as Address, weightBps: Math.max(1, Math.round((row.deltaUsd / gap) * TOTAL_BPS)) }));
  // Rounding leaves a few basis points over or under; the largest leg absorbs them so the weights add to exactly 100%.
  const drift = TOTAL_BPS - weights.reduce((s, w) => s + w.weightBps, 0);
  weights[0]!.weightBps += drift;
  return { allocations: weights, totalUsd: Math.min(amountUsd, gap) };
}
