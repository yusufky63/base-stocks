import { beforeEach, describe, expect, it, vi } from "vitest";
import type { B20Asset } from "@/domain/asset";
import { WAD } from "@/lib/b20/math";

const multicall = vi.fn();
vi.mock("@/lib/viem/server-client", () => ({ getServerPublicClient: () => ({ multicall }) }));

const requireAsset = vi.fn();
vi.mock("./b20-asset-service", () => ({ requireAsset: (a: string) => requireAsset(a) }));

const { B20GuardService } = await import("./b20-guard-service");

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as const;
const USER = "0x2211d1D0020DAEA8039E46Cf1367962070d77DA9" as const;

function asset(over: Partial<B20Asset> = {}): B20Asset {
  return {
    address: NVDA,
    canonicalId: NVDA.toLowerCase(),
    name: "NVIDIA Corporation",
    symbol: "NVDAc",
    underlying: "NVDA",
    decimals: 8,
    tags: ["technology"],
    multiplier: WAD,
    wadPrecision: WAD,
    totalSupply: 1_000_000_00n,
    supplyKnown: true,
    transferSenderPolicyId: 5n,
    transferReceiverPolicyId: 5n,
    transferPaused: false,
    status: "active",
    verification: "verified",
    readAt: 0,
    oracle: { feed: "0x04689a41629776563E6822F76f2e57D148d28513", answer: 21880720000n, updatedAt: 0n, decimals: 8, paused: false, stale: false, staleAfterSeconds: 3600, freshness: "live", marketOpen: true, priceUsd: 218.8 },
    ...over,
  };
}

describe("B20GuardService", () => {
  const guard = new B20GuardService();
  beforeEach(() => {
    multicall.mockReset();
    requireAsset.mockReset();
  });

  it("blocks trades when transfers are paused", async () => {
    requireAsset.mockResolvedValue(asset({ transferPaused: true, status: "paused" }));
    await expect(guard.preTradeCheck({ assetAddress: NVDA, side: "buy", taker: USER })).rejects.toMatchObject({ code: "B20_TRANSFER_PAUSED" });
  });

  it("blocks a buy when the receiver is not authorized by the issuer policy", async () => {
    requireAsset.mockResolvedValue(asset());
    multicall.mockResolvedValue([{ status: "success", result: false }]);
    await expect(guard.preTradeCheck({ assetAddress: NVDA, side: "buy", taker: USER })).rejects.toMatchObject({ code: "B20_POLICY_BLOCKED" });
    expect(multicall).toHaveBeenCalledTimes(1);
  });

  it("skips the registry when the policy is ALWAYS_ALLOW (id 0)", async () => {
    requireAsset.mockResolvedValue(asset({ transferSenderPolicyId: 0n, transferReceiverPolicyId: 0n }));
    const r = await guard.preTradeCheck({ assetAddress: NVDA, side: "sell", taker: USER });
    expect(multicall).not.toHaveBeenCalled();
    expect(r.warnings).toEqual([]);
  });

  it("says nothing about a stale reference: the feeds run 24/5, so it is the normal overnight state", async () => {
    requireAsset.mockResolvedValue(asset({ oracle: { feed: "0x04689a41629776563E6822F76f2e57D148d28513", answer: 1n, updatedAt: 0n, decimals: 8, paused: false, stale: true, staleAfterSeconds: 3600, freshness: "last-close", marketOpen: false, priceUsd: 1 } }));
    multicall.mockResolvedValue([{ status: "success", result: true }]);
    const r = await guard.preTradeCheck({ assetAddress: NVDA, side: "buy", taker: USER });
    // Not blocked either — staleness never gated the trade, and still does not.
    expect(r.warnings).toEqual([]);
  });

  it("says nothing about a frozen reference either, and still does not block the trade", async () => {
    requireAsset.mockResolvedValue(asset({ oracle: { feed: "0x04689a41629776563E6822F76f2e57D148d28513", answer: 1n, updatedAt: 0n, decimals: 8, paused: true, stale: false, staleAfterSeconds: 3600, freshness: "frozen", marketOpen: true, priceUsd: 1 } }));
    multicall.mockResolvedValue([{ status: "success", result: true }]);
    const r = await guard.preTradeCheck({ assetAddress: NVDA, side: "buy", taker: USER });
    // The swap settles against the pool, not the feed, so the feed's state is not the trader's problem.
    expect(r.warnings).toEqual([]);
  });

  it("rejects the wrong chain before touching the registry", async () => {
    requireAsset.mockResolvedValue(asset());
    await expect(guard.preTradeCheck({ assetAddress: NVDA, side: "buy", taker: USER, chainId: 1 })).rejects.toMatchObject({ code: "WRONG_NETWORK" });
    expect(requireAsset).not.toHaveBeenCalled();
  });

  it("checks both sender and receiver for sends and names the blocked role", async () => {
    requireAsset.mockResolvedValue(asset());
    multicall.mockResolvedValue([
      { status: "success", result: true },
      { status: "success", result: false },
    ]);
    await expect(guard.preSendCheck({ assetAddress: NVDA, sender: USER, recipient: "0x000000000000000000000000000000000000dEaD" })).rejects.toMatchObject({ code: "B20_POLICY_BLOCKED", details: { role: "receiver" } });
  });
});
