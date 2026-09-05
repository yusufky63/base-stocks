import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";

/**
 * A basket used to cost two confirmations per stock: approve two dollars of USDC, buy, approve the
 * next two dollars, buy. The approvals were the waste. Every leg that pays through the same router
 * can share one approval for the basket's total, and a wallet that batches (EIP-5792: Base Account,
 * and any wallet that has taken the 7702 upgrade) can take the approvals and every purchase in one
 * confirmation. These helpers work out the approvals; the hook decides how to send them.
 */
export interface QuotedLeg {
  stepId: string;
  sellToken: Address;
  sellAmount: bigint;
  /** The provider's spender for this route; null when nothing has to be approved (native ETH). */
  spender: Address | null;
  call: { to: Address; data: Hex; value: bigint };
}

export interface AllowanceNeed {
  token: Address;
  spender: Address;
  /** The basket's total through this route: exactly what the run can spend, nothing standing afterwards. */
  total: bigint;
}

export type Call = { to: Address; data: Hex; value: bigint };

/** One approval per (token, spender), for the sum of every leg that pays through it. Input order is kept. */
export function allowanceNeeds(legs: QuotedLeg[]): AllowanceNeed[] {
  const needs = new Map<string, AllowanceNeed>();
  for (const leg of legs) {
    if (!leg.spender || leg.sellAmount <= 0n) continue;
    const key = `${leg.sellToken.toLowerCase()}:${leg.spender.toLowerCase()}`;
    const current = needs.get(key);
    if (current) current.total += leg.sellAmount;
    else needs.set(key, { token: leg.sellToken, spender: leg.spender, total: leg.sellAmount });
  }
  return [...needs.values()];
}

/** The approvals still missing, given what each route may already spend. */
export function approvalCalls(needs: AllowanceNeed[], current: (need: AllowanceNeed) => bigint): Call[] {
  return needs
    .filter((n) => current(n) < n.total)
    .map((n) => ({ to: n.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [n.spender, n.total] }), value: 0n }));
}

/**
 * Which receipt settled which leg. An atomic batch lands as one transaction and every leg shares
 * its receipt; a wallet that batched without atomicity returns one receipt per call, approvals
 * first, so the leg's receipt sits after them.
 */
export function receiptForLeg<R>(receipts: R[], approvals: number, legIndex: number, legs: number): R | undefined {
  if (receipts.length === approvals + legs) return receipts[approvals + legIndex];
  return receipts[receipts.length - 1];
}

/** What the review screen can promise about confirmations before a single quote exists. */
export function confirmationsCopy(purchases: number, wallet: { supported: boolean; atomic: boolean; paymaster: boolean } | undefined): string {
  const n = `${purchases} ${purchases === 1 ? "purchase" : "purchases"}`;
  if (wallet?.atomic) return `One confirmation: the USDC approval and all ${n} in one transaction${wallet.paymaster ? ", gas sponsored" : ""}. Either everything lands or nothing does.`;
  if (wallet?.supported) return `One confirmation for the USDC approval and all ${n}; your wallet sends them together.`;
  return `USDC is approved once for the whole basket, then ${n} confirmed one by one.`;
}
