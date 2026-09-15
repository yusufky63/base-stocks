import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hash } from "viem";
import type { Quest } from "@/domain/pool";

/**
 * The `buy-asset` quest: a purchase is the stock arriving AND USDC leaving the claimant's wallet,
 * read through `verifyTrade` (which is `tradeFacts` over a cached receipt). A transfer in from a
 * friend moves the stock but no USDC, and must not pass.
 */
const verifyTrade = vi.fn();
const listByOwner = vi.fn();

vi.mock("@/services/tx-verify-service", () => ({ verifyTrade: (...a: unknown[]) => verifyTrade(...a) }));
vi.mock("@/db/repositories", () => ({ getRepos: () => ({ trades: { listByOwner: (...a: unknown[]) => listByOwner(...a) } }) }));
vi.mock("@/lib/viem/server-client", () => ({ getServerPublicClient: () => ({ readContract: vi.fn() }) }));
vi.mock("@/services/b20-asset-service", () => ({
  getAssets: async () => [{ address: NVDA, canonicalId: NVDA.toLowerCase(), underlying: "NVDA", decimals: 8, multiplier: 10n ** 18n, wadPrecision: 10n ** 18n }],
}));
vi.mock("@/services/basename-service", () => ({ reverseResolve: async () => null }));
vi.mock("@/lib/http", () => ({ metrics: { count: vi.fn() } }));

import { verifyQuests } from "./quest-service";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const ME = "0x78de409a6306550882328E2a67160471368387FF" as Address;
const TX1 = `0x${"1".repeat(64)}` as Hash;
const TX2 = `0x${"2".repeat(64)}` as Hash;
const quest: Quest = { type: "buy-asset", assetAddress: NVDA, minUsd: 10, withinDays: 30 };
const trade = (txHash: Hash, over: Record<string, unknown> = {}) => ({ id: txHash, side: "buy", assetAddress: NVDA, txHash, createdAt: Date.now() - 1000, status: "confirmed", ...over });

beforeEach(() => vi.clearAllMocks());

describe("buy-asset", () => {
  it("passes when USDC left the wallet for the stock, and values it by the USDC that settled", async () => {
    listByOwner.mockResolvedValue([trade(TX1)]);
    verifyTrade.mockResolvedValue({ ok: true, blockNumber: 1, assetAmount: 5_000_000n, usdcAmount: 12_500_000n, initiatedByOwner: true });
    const [r] = await verifyQuests([quest], ME);
    expect(r!.done).toBe(true);
    expect(r!.proof).toMatchObject({ txs: [TX1], usd: 12.5 });
    expect(verifyTrade).toHaveBeenCalledWith({ txHash: TX1, owner: ME, assetAddress: NVDA, side: "buy" });
  });

  it("does not count a transfer in: the stock arrived but no USDC left", async () => {
    listByOwner.mockResolvedValue([trade(TX1)]);
    verifyTrade.mockResolvedValue({ ok: true, blockNumber: 1, assetAmount: 5_000_000n, usdcAmount: null, initiatedByOwner: true });
    const [r] = await verifyQuests([quest], ME);
    expect(r!.done).toBe(false);
    expect(r!.detail).toMatch(/transfer in does not/);
  });

  it("adds purchases up and compares the USDC total to the minimum", async () => {
    listByOwner.mockResolvedValue([trade(TX1), trade(TX2)]);
    verifyTrade.mockResolvedValueOnce({ ok: true, blockNumber: 1, assetAmount: 1n, usdcAmount: 4_000_000n, initiatedByOwner: true }).mockResolvedValueOnce({ ok: true, blockNumber: 2, assetAmount: 1n, usdcAmount: 4_000_000n, initiatedByOwner: true });
    const [r] = await verifyQuests([quest], ME);
    expect(r!.done).toBe(false);
    expect(r!.detail).toMatch(/\$8\.00 bought on BStocks so far/);
  });

  it("says so when the receipt is not in yet, and ignores rows the app already failed", async () => {
    listByOwner.mockResolvedValue([trade(TX1), trade(TX2, { status: "failed" })]);
    verifyTrade.mockResolvedValue({ ok: false, state: "pending", reason: "" });
    const [r] = await verifyQuests([quest], ME);
    expect(r!.done).toBe(false);
    expect(r!.detail).toMatch(/not confirm that purchase onchain yet/);
    expect(verifyTrade).toHaveBeenCalledTimes(1);
  });

  it("finds nothing to check without a matching trade row in the window", async () => {
    listByOwner.mockResolvedValue([trade(TX1, { createdAt: Date.now() - 40 * 86_400_000 })]);
    const [r] = await verifyQuests([quest], ME);
    expect(r!.done).toBe(false);
    expect(r!.detail).toMatch(/bought on BStocks/);
    expect(verifyTrade).not.toHaveBeenCalled();
  });
});

describe("visit-url", () => {
  it("always names the destination host, whatever the creator called the step", async () => {
    const [r] = await verifyQuests([{ type: "visit-url", url: "https://www.example.com/launch", label: "Read the launch post" }], ME);
    expect(r!.label).toBe("Read the launch post");
    expect(r!.detail).toMatch(/Opens example\.com/);
    expect(r!.actionUrl).toBe("https://www.example.com/launch");
  });
});
