import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type { PoolLegView, PoolView } from "@/domain/pool";
import { remainingShares, shareLabel } from "./PoolList";

const leg = (underlying: string, scaledPerClaim: string): PoolLegView => ({
  token: `0x${underlying.padEnd(40, "0")}` as Address,
  amountPerClaim: scaledPerClaim,
  symbol: `${underlying}c`,
  underlying,
  decimals: 8,
  scaledPerClaim,
  usdPerClaim: null,
});

const view = (over: Partial<PoolView> & { legs?: PoolLegView[] } = {}): PoolView => ({
  pool: {
    id: "pool_x",
    onchainId: "0x00" as Hex,
    creator: "0x78de409a6306550882328E2a67160471368387FF" as Address,
    gateMode: "open",
    gateAddress: "0x0000000000000000000000000000000000000000" as Address,
    slots: 10,
    legs: [],
    expiry: Date.now() + 86_400_000,
    lockedUntil: 0,
    visibility: "public",
    verified: false,
    quests: [],
    memo: "0x00" as Hex,
    status: "live",
    createdAt: Date.now(),
    ...over.pool,
  },
  onchain: over.onchain ?? null,
  legs: over.legs ?? [leg("NVDA", "10000000")],
  usdPerClaim: null,
  claimCount: over.claimCount ?? 0,
  creatorBasename: null,
});

/**
 * These two shape what the directory card, the Gifts tab and the home teaser all say, so they are
 * worth pinning even though the markup around them is not.
 */
describe("pool list helpers", () => {
  it("names a single-stock share by its scaled amount", () => {
    expect(shareLabel(view())).toBe("0.1 NVDA");
  });

  it("joins a package so a claimer sees everything they get", () => {
    expect(shareLabel(view({ legs: [leg("NVDA", "10000000"), leg("AAPL", "5000000")] }))).toBe("0.1 NVDA + 0.05 AAPL");
  });

  it("degrades rather than rendering an empty share", () => {
    expect(shareLabel(view({ legs: [] }))).toBe("a stock");
  });

  it("trusts the chain for the remaining count when it has been read", () => {
    const onchain = {
      exists: true,
      creator: "0x78de409a6306550882328E2a67160471368387FF" as Address,
      gate: "0x0000000000000000000000000000000000000000" as Address,
      slots: 10,
      claimed: 7,
      expiry: Date.now() + 86_400_000,
      lockedUntil: 0,
      cancelled: false,
      remainingSlots: 3,
      legs: [],
    };
    // The database says two claims, the chain says seven; the chain wins.
    expect(remainingShares(view({ onchain, claimCount: 2 }))).toBe(3);
  });

  it("falls back to the claim count when the chain has not answered", () => {
    expect(remainingShares(view({ claimCount: 4 }))).toBe(6);
    expect(remainingShares(view({ claimCount: 99 }))).toBe(0); // never negative
  });
});
