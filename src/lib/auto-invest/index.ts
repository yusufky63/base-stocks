import { BaseError, ContractFunctionRevertedError, parseUnits, type Address, type Hex } from "viem";
import { USDC_DECIMALS } from "@/config/chain";
import { TOTAL_BPS, USDC_ALLOCATION_KEY, type Allocation } from "@/domain/portfolio";

export { autoInvestAbi } from "./abi";

/**
 * BStocks AutoInvest (contracts/src/AutoInvest.sol): recurring purchases that run without the owner
 * present. The address comes from `NEXT_PUBLIC_AUTO_INVEST_ADDRESS` so a preview or a fork can point
 * elsewhere; unset means "not deployed here" and the app offers only plans you confirm by hand.
 */
export const AUTO_INVEST_ADDRESS = (process.env.NEXT_PUBLIC_AUTO_INVEST_ADDRESS ?? "") as Address | "";

const ZERO = "0x0000000000000000000000000000000000000000";

export function isAutoInvestDeployed(): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(AUTO_INVEST_ADDRESS) && AUTO_INVEST_ADDRESS.toLowerCase() !== ZERO;
}

/* ------------------------------ contract constants ------------------------------ */

/** Mirrors the contract; the UI validates against these before asking for a signature. */
export const AUTO_INVEST = {
  MAX_LEGS: 12,
  MIN_INTERVAL_S: 3600,
  MAX_INTERVAL_S: 366 * 24 * 3600,
  MAX_PLAN_DURATION_S: 5 * 365 * 24 * 3600,
  MIN_SLIPPAGE_BPS: 10,
  MAX_SLIPPAGE_BPS: 2_000,
  /** Reference floor: a run may fill at most this far above the Chainlink price. */
  DEFAULT_SLIPPAGE_BPS: 300,
  ALLOWLIST_DELAY_S: 24 * 3600,
  MIN_AMOUNT_USD: 1,
} as const;

export type PlanStatus = "active" | "paused" | "cancelled";

export function planStatusFromCode(code: number): PlanStatus {
  return code === 2 ? "cancelled" : code === 1 ? "paused" : "active";
}

export const CADENCES = [
  { days: 1, label: "Daily", noun: "day" },
  { days: 7, label: "Weekly", noun: "week" },
  { days: 14, label: "Biweekly", noun: "two weeks" },
  { days: 30, label: "Monthly", noun: "month" },
] as const;

export function cadenceLabel(days: number): string {
  return CADENCES.find((c) => c.days === days)?.label ?? `Every ${days} days`;
}

export function cadenceNoun(days: number): string {
  return CADENCES.find((c) => c.days === days)?.noun ?? `${days} days`;
}

export function cadenceToInterval(days: number): number {
  return Math.max(AUTO_INVEST.MIN_INTERVAL_S, Math.round(days * 24 * 3600));
}

export function intervalToCadenceDays(intervalSeconds: number): number {
  return Math.max(1, Math.round(intervalSeconds / 86_400));
}

/** USD → USDC base units, the way every plan amount is stored onchain. */
export function usdToUsdc(usd: number): bigint {
  return parseUnits(Math.max(0, usd).toFixed(USDC_DECIMALS), USDC_DECIMALS);
}

export function usdcToUsd(units: bigint | string): number {
  return Number(BigInt(units)) / 10 ** USDC_DECIMALS;
}

/** A leg's share of one run, floored exactly as the contract caps it. */
export function legAmountIn(amountPerRun: bigint, weightBps: number): bigint {
  return (amountPerRun * BigInt(weightBps)) / BigInt(TOTAL_BPS);
}

/* ------------------------------ plan shapes ------------------------------ */

export interface OnchainLeg {
  asset: Address;
  weightBps: number;
}

export interface OnchainPlan {
  planId: bigint;
  owner: Address;
  amountPerRun: bigint;
  interval: number;
  /** Unix seconds. */
  nextRunAt: number;
  /** Unix seconds; 0 = no expiry. */
  expiry: number;
  maxSlippageBps: number;
  runs: number;
  lastRunAt: number;
  status: PlanStatus;
  legs: OnchainLeg[];
}

/** The `plans(id)` tuple as viem returns it. */
export type PlanTuple = readonly [Address, bigint, number, number, number, number, number, number, number];

export function decodePlan(planId: bigint, t: PlanTuple, legs: ReadonlyArray<{ asset: Address; weightBps: number }>): OnchainPlan {
  return {
    planId,
    owner: t[0],
    amountPerRun: t[1],
    interval: Number(t[2]),
    nextRunAt: Number(t[3]),
    expiry: Number(t[4]),
    maxSlippageBps: Number(t[5]),
    runs: Number(t[6]),
    lastRunAt: Number(t[7]),
    status: planStatusFromCode(Number(t[8])),
    legs: legs.map((l) => ({ asset: l.asset, weightBps: Number(l.weightBps) })),
  };
}

/** Stock legs only; the cash share of a basket simply never leaves the wallet. */
export function legsFromAllocations(allocations: Allocation[]): { assets: Address[]; weightsBps: number[] } {
  const stocks = allocations.filter((a) => a.assetAddress !== USDC_ALLOCATION_KEY);
  const total = stocks.reduce((s, a) => s + a.weightBps, 0);
  if (total <= 0) return { assets: [], weightsBps: [] };
  // Re-normalise to exactly 100% across the stocks; the largest leg absorbs the rounding.
  const weights = stocks.map((a) => Math.max(1, Math.round((a.weightBps / total) * TOTAL_BPS)));
  const drift = TOTAL_BPS - weights.reduce((s, w) => s + w, 0);
  if (drift !== 0) {
    const biggest = weights.reduce((best, w, i) => (w > weights[best]! ? i : best), 0);
    weights[biggest]! += drift;
  }
  return { assets: stocks.map((a) => a.assetAddress as Address), weightsBps: weights };
}

export function allocationsFromLegs(legs: OnchainLeg[]): Allocation[] {
  return legs.map((l) => ({ assetAddress: l.asset, weightBps: l.weightBps }));
}

/** What a plan owner has to keep approved and funded for the next run to go through. */
export interface PlanFunding {
  usdcBalance: string;
  allowance: string;
  /** Balance and allowance both cover one run. */
  enough: boolean;
  /** Whole runs the current allowance still covers. */
  runsCovered: number;
}

export function assessFunding(usdcBalance: bigint, allowance: bigint, amountPerRun: bigint): PlanFunding {
  const runsCovered = amountPerRun > 0n ? Number(allowance / amountPerRun) : 0;
  return { usdcBalance: usdcBalance.toString(), allowance: allowance.toString(), enough: usdcBalance >= amountPerRun && allowance >= amountPerRun, runsCovered };
}

/* ------------------------------ swaps ------------------------------ */

/** One leg of an `execute` call: built from an aggregator quote with the owner as recipient. */
export interface AutoInvestSwap {
  target: Address;
  spender: Address;
  amountIn: bigint;
  minOut: bigint;
  data: Hex;
}

/** JSON-safe twin for API responses. */
export interface AutoInvestSwapDTO {
  target: Address;
  spender: Address;
  amountIn: string;
  minOut: string;
  data: Hex;
}

export function swapToDto(s: AutoInvestSwap): AutoInvestSwapDTO {
  return { ...s, amountIn: s.amountIn.toString(), minOut: s.minOut.toString() };
}

export function swapFromDto(s: AutoInvestSwapDTO): AutoInvestSwap {
  return { ...s, amountIn: BigInt(s.amountIn), minOut: BigInt(s.minOut) };
}

/** An empty swap skips a leg: its share stays in the owner's wallet. */
export function skippedSwap(): AutoInvestSwap {
  return { target: ZERO, spender: ZERO, amountIn: 0n, minOut: 0n, data: "0x" };
}

/* ------------------------------ errors ------------------------------ */

export const AUTO_INVEST_ERROR_COPY: Record<string, string> = {
  NotOwner: "Only the operator can do that.",
  NotKeeper: "Only the keeper or the plan owner can run a plan.",
  NotPlanOwner: "This plan belongs to another wallet.",
  PlanUnknown: "That plan does not exist onchain.",
  PlanNotActive: "The plan is paused or cancelled.",
  PlanIsCancelled: "The plan was cancelled; create a new one instead.",
  NotDue: "The next run is not due yet.",
  PlanExpired: "The plan has expired.",
  BadLegs: "A plan needs between one and twelve stocks.",
  BadWeights: "Weights must add up to exactly 100%.",
  DuplicateAsset: "A stock appears twice in the plan.",
  BadAmount: "The amount per run must be at least $1.",
  BadInterval: "Runs must be between one hour and a year apart.",
  BadExpiry: "The expiry must be in the future and within five years.",
  BadSlippage: "The slippage tolerance must be between 0.1% and 20%.",
  BadSwaps: "The run does not match the plan's legs.",
  LegTooLarge: "A leg asked for more than its share of the run.",
  NothingToBuy: "Every leg was skipped; nothing to buy this run.",
  RouteNotAllowed: "That swap route is not on the contract's allow-list.",
  SwapFailed: "The swap reverted.",
  TooLittleReceived: "The route would have delivered less than the plan allows; the run was cancelled before any USDC moved.",
  TransferFailed: "USDC could not be pulled: check the balance and the allowance.",
  Reentered: "Reentrancy blocked.",
  NotProposed: "That route was never announced.",
  DelayNotPassed: "The 24-hour announcement period has not passed.",
  ZeroAddress: "Zero address.",
};

/** Name and copy for a revert from the contract, when the error is one of its own. */
export function decodeAutoInvestError(err: unknown): { name: string; args: readonly unknown[]; message: string } | null {
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError) || !revert.data?.errorName) return null;
  const name = revert.data.errorName;
  return { name, args: revert.data.args ?? [], message: AUTO_INVEST_ERROR_COPY[name] ?? `Contract error: ${name}` };
}
