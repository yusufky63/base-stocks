import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The read rotation, checked without a network.
 *
 * The point of the rotation is a bill that divides, so what these assert is the division itself:
 * how many calls in a hundred each provider draws, and that a provider which cannot serve a wide
 * `eth_getLogs` never leads one. Both are silent when wrong — the app keeps working, one account
 * just keeps paying for everything — so they are worth pinning.
 */
const ALCHEMY = "https://base-mainnet.g.alchemy.example/v2/key";
const DRPC = "https://lb.drpc.example/base/key";
const CDP = "https://api.developer.coinbase.example/rpc/v1/base/key";

const original = { ...process.env };

/**
 * Warm the module graph once. viem plus the chain config takes seconds to load cold, and without
 * this the first test spends its whole budget on an import the other four get for free.
 */
beforeAll(async () => {
  process.env.BASE_RPC_URL = ALCHEMY;
  await import("./server-client");
}, 60_000);

afterAll(() => {
  process.env = { ...original };
});

beforeEach(() => {
  vi.resetModules();
  process.env.BASE_RPC_URL = ALCHEMY;
  process.env.DRPC_RPC_URL = DRPC;
  process.env.NEXT_PUBLIC_PAYMASTER_URL = CDP;
  delete process.env.RPC_WEIGHTS;
});

afterEach(() => {
  process.env = { ...original };
});

/** How the calls divided, largest share first — client identity is the only thing that matters. */
function division(next: () => unknown, calls: number): number[] {
  const counts = new Map<unknown, number>();
  for (let i = 0; i < calls; i += 1) {
    const client = next();
    counts.set(client, (counts.get(client) ?? 0) + 1);
  }
  return [...counts.values()].sort((a, b) => b - a);
}

describe("server read rotation", () => {
  it("divides reads evenly across the keyed providers by default", async () => {
    const { getServerPublicClient, rpcRotation } = await import("./server-client");
    expect(division(getServerPublicClient, 30)).toEqual([10, 10, 10]);
    expect(rpcRotation().map((r) => [r.name, r.share])).toEqual([
      ["alchemy", 1 / 3],
      ["drpc", 1 / 3],
      ["cdp", 1 / 3],
    ]);
  });

  it("honours RPC_WEIGHTS so a provider can be weighted down without a deploy", async () => {
    process.env.RPC_WEIGHTS = "alchemy=1,drpc=2,cdp=2";
    const { getServerPublicClient, rpcRotation } = await import("./server-client");
    expect(division(getServerPublicClient, 30)).toEqual([12, 12, 6]);
    expect(rpcRotation().find((r) => r.name === "alchemy")?.share).toBe(0.2);
  });

  it("keeps CDP out of the lead for log reads, since its getLogs caps at 1,000 blocks", async () => {
    const { getLogPublicClient, rpcRotation } = await import("./server-client");
    // Two providers left, so an even split of twenty is ten each — CDP draws none.
    expect(division(getLogPublicClient, 20)).toEqual([10, 10]);
    expect(rpcRotation().filter((r) => r.leadsLogs).map((r) => r.name)).toEqual(["alchemy", "drpc"]);
  });

  it("still leads log reads with CDP when it is the only provider configured", async () => {
    delete process.env.BASE_RPC_URL;
    delete process.env.DRPC_RPC_URL;
    const { getLogPublicClient, rpcRotation } = await import("./server-client");
    expect(division(getLogPublicClient, 4)).toEqual([4]);
    expect(rpcRotation().map((r) => r.name)).toEqual(["cdp"]);
  });

  it("serves reads from the public endpoints when nothing keyed is configured", async () => {
    delete process.env.BASE_RPC_URL;
    delete process.env.DRPC_RPC_URL;
    delete process.env.NEXT_PUBLIC_PAYMASTER_URL;
    const { getServerPublicClient, rpcRotation } = await import("./server-client");
    expect(rpcRotation()).toEqual([]);
    expect(division(getServerPublicClient, 4)).toEqual([4]);
    expect(getServerPublicClient()).toBeDefined();
  });
});
