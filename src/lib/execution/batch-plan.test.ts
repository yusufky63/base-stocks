import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, type Address } from "viem";
import { allowanceNeeds, approvalCalls, confirmationsCopy, receiptForLeg, type QuotedLeg } from "./batch-plan";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const KYBER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as Address;
const OKX = "0x57df6092665eb6058DE53939612413ff4B09114E" as Address;
const leg = (id: string, spender: Address | null, usdc: bigint): QuotedLeg => ({ stepId: id, sellToken: USDC, sellAmount: usdc, spender, call: { to: spender ?? USDC, data: "0x", value: 0n } });

describe("approvals for a basket", () => {
  it("sums every leg that pays through the same router into one approval", () => {
    const needs = allowanceNeeds([leg("a", KYBER, 2_000_000n), leg("b", KYBER, 3_000_000n), leg("c", KYBER, 5_000_000n)]);
    expect(needs).toEqual([{ token: USDC, spender: KYBER, total: 10_000_000n }]);
  });

  it("keeps routes apart, in the order they first appear", () => {
    const needs = allowanceNeeds([leg("a", KYBER, 2_000_000n), leg("b", OKX, 4_000_000n), leg("c", KYBER, 1_000_000n)]);
    expect(needs.map((n) => [n.spender, n.total])).toEqual([
      [KYBER, 3_000_000n],
      [OKX, 4_000_000n],
    ]);
  });

  it("ignores legs with nothing to approve", () => {
    expect(allowanceNeeds([leg("a", null, 2_000_000n), leg("b", KYBER, 0n)])).toEqual([]);
  });

  /** Exactly the total, to exactly the spender: no standing allowance is left behind. */
  it("approves only the routes that are short, for the basket's total", () => {
    const needs = allowanceNeeds([leg("a", KYBER, 2_000_000n), leg("b", OKX, 4_000_000n)]);
    const calls = approvalCalls(needs, (n) => (n.spender === OKX ? 10_000_000n : 0n));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe(USDC);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: calls[0]!.data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args).toEqual([KYBER, 2_000_000n]);
  });
});

describe("which receipt settled which leg", () => {
  it("shares the single receipt of an atomic batch across every leg", () => {
    expect(receiptForLeg(["r1"], 1, 0, 3)).toBe("r1");
    expect(receiptForLeg(["r1"], 1, 2, 3)).toBe("r1");
  });

  it("skips the approvals when a wallet returned one receipt per call", () => {
    expect(receiptForLeg(["approve", "buy0", "buy1"], 1, 0, 2)).toBe("buy0");
    expect(receiptForLeg(["approve", "buy0", "buy1"], 1, 1, 2)).toBe("buy1");
  });
});

describe("what the review screen promises", () => {
  it("names the one confirmation on a wallet that batches atomically", () => {
    expect(confirmationsCopy(5, { supported: true, atomic: true, paymaster: true })).toContain("One confirmation");
    expect(confirmationsCopy(5, { supported: true, atomic: true, paymaster: true })).toContain("gas sponsored");
  });

  it("promises one approval, not one per stock, on a classic wallet", () => {
    expect(confirmationsCopy(5, { supported: false, atomic: false, paymaster: false })).toBe("USDC is approved once for the whole basket, then 5 purchases confirmed one by one.");
    expect(confirmationsCopy(1, undefined)).toContain("1 purchase confirmed");
  });
});
