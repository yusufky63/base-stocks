import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { USDC_ADDRESS } from "@/config/chain";
import { pickBalances } from "./useTokenBalances";

/**
 * The balances used to come from the browser's own multicall; they now come from the portfolio
 * snapshot. These pin the translation, since getting it wrong would silently show someone the
 * wrong buying power.
 */
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const TSLA = "0xb2000000000000000000001e800a7f5189430cD0" as Address;

const snapshot = {
  usdcBalance: "5000000",
  holdings: [
    { assetAddress: NVDA.toLowerCase(), rawBalance: "1234567890000000000", scaledBalance: "2469135780000000000" },
    { assetAddress: TSLA, rawBalance: "0", scaledBalance: "0" },
  ],
} as unknown as Parameters<typeof pickBalances>[0];

describe("pickBalances", () => {
  it("reads a stock's raw and share-equivalent balance, case-insensitively", () => {
    expect(pickBalances(snapshot, NVDA)).toEqual({ usdc: 5_000_000n, raw: 1234567890000000000n, scaled: 2469135780000000000n });
    // The snapshot lowercases addresses; a checksummed one from the asset registry must still match.
    expect(pickBalances(snapshot, NVDA.toUpperCase() as Address).raw).toBe(1234567890000000000n);
  });

  it("treats USDC as the asset by returning the cash balance", () => {
    expect(pickBalances(snapshot, USDC_ADDRESS)).toEqual({ usdc: 5_000_000n, raw: 5_000_000n, scaled: 5_000_000n });
  });

  it("reads a stock the wallet does not hold as zero, not as missing", () => {
    const unheld = "0xb200000000000000000000C2e324d24d7eEcd1fb" as Address;
    expect(pickBalances(snapshot, unheld)).toEqual({ usdc: 5_000_000n, raw: 0n, scaled: 0n });
  });

  it("is safe before the snapshot arrives", () => {
    expect(pickBalances(undefined, NVDA)).toEqual({ usdc: 0n, raw: 0n, scaled: 0n });
    expect(pickBalances(snapshot, undefined)).toEqual({ usdc: 5_000_000n, raw: 0n, scaled: 0n });
  });

  it("never throws on a malformed amount", () => {
    const bad = { usdcBalance: "not a number", holdings: [{ assetAddress: NVDA, rawBalance: "1.5", scaledBalance: "" }] } as unknown as Parameters<typeof pickBalances>[0];
    expect(pickBalances(bad, NVDA)).toEqual({ usdc: 0n, raw: 0n, scaled: 0n });
  });
});
