import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { DiscoveredAsset } from "@/db/repositories";

const h = vi.hoisted(() => ({
  rows: [] as DiscoveredAsset[],
  beforePromote: vi.fn(),
  listings: vi.fn(),
  nav: vi.fn(),
  feed: vi.fn(),
  readings: vi.fn(),
  markets: vi.fn(),
  routes: vi.fn(),
  list: vi.fn(),
  client: { getBlockNumber: vi.fn(), getContractEvents: vi.fn(), getTransaction: vi.fn(), readContract: vi.fn(), multicall: vi.fn() },
}));
vi.mock("@/providers/coinbase/tokenized-stocks", () => ({ getCoinbaseStockListings: h.listings, getCoinbaseNavReadings: h.nav }));
vi.mock("@/providers/market-data/chainlink/directory", () => ({ findCoinbaseFeed: h.feed }));
vi.mock("@/providers/market-data/chainlink/reader", () => ({ readFeeds: h.readings }));
vi.mock("@/lib/viem/server-client", () => ({ getServerPublicClient: () => h.client }));
vi.mock("@/lib/shared-store", () => ({ getSharedStore: () => null }));
vi.mock("@/lib/last-good", () => ({ recallGood: async () => null, rememberGood: vi.fn() }));
vi.mock("@/providers/market-data", () => ({ getMarketDataProvider: () => ({ getTokenMarkets: h.markets }) }));
vi.mock("./asset-tradability-service", async (importOriginal) => ({ ...await importOriginal<typeof import("./asset-tradability-service")>(), hasTwoWayStockRoute: h.routes }));
vi.mock("@/config/env", () => ({ serverEnv: () => ({ ORACLE_STALENESS_SECONDS: 93_600 }) }));
vi.mock("@/db/repositories", () => ({ getRepos: () => ({ discoveredAssets: {
  list: h.list,
  listStrict: h.list,
  upsert: async (rows: DiscoveredAsset[]) => {
    for (const row of rows) {
      const index = h.rows.findIndex((r) => r.address.toLowerCase() === row.address.toLowerCase());
      if (index < 0) h.rows.push(row);
      else h.rows[index] = { ...row, verification: h.rows[index].verification };
    }
  },
  autoVerify: async (address: Address) => {
    h.beforePromote();
    const row = h.rows.find((r) => r.address.toLowerCase() === address.toLowerCase());
    if (row?.verification === "discovered") row.verification = "verified";
  },
  setVerification: async (address: Address, verification: DiscoveredAsset["verification"]) => {
    const row = h.rows.find((r) => r.address.toLowerCase() === address.toLowerCase());
    if (row) row.verification = verification;
  },
} }) }));

import { invalidate } from "@/lib/cache";
import { discoveredEntries, setDiscoveredEntries } from "@/lib/b20/registry";
import { discoverNewAssets, getAsset, loadDiscoveredRegistry, syncDiscoveredAssets } from "./b20-asset-service";

const AMD = "0xb2000000000000000000000d8ce462e99ee7a47b" as Address;
const FEED = "0x1111111111111111111111111111111111111111" as Address;
const CREATOR = "0xe090ecbee12d4b6aee5e73ff60945f2545ef5c6f" as Address;
const listing = { address: AMD, symbol: "AMDc", name: "Advanced Micro Devices" };
const pending = (over: Partial<DiscoveredAsset> = {}): DiscoveredAsset => ({ address: AMD, symbol: "AMDc", name: listing.name, underlying: "AMD", blockNumber: 49_000_000, verification: "discovered", updatedAt: 0, ...over });
const ok = (result: unknown) => ({ status: "success", result });
const price = (answer = 100_00000000n, updatedAt = BigInt(Math.floor(Date.now() / 1000))) => new Map([[FEED.toLowerCase(), { feed: FEED, answer, updatedAt, decimals: 8 }]]);

beforeEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  await invalidate("");
  h.rows = [];
  h.beforePromote.mockImplementation(() => {});
  h.markets.mockImplementation(async () => new Map([[AMD.toLowerCase(), { address: AMD, primaryPool: FEED, priceUsd: 100, liquidityUsd: 5000, updatedAt: Date.now(), source: "dexscreener" }]]));
  h.routes.mockResolvedValue(true);
  setDiscoveredEntries([]);
  h.list.mockImplementation(async () => h.rows);
  h.listings.mockResolvedValue([listing]);
  h.nav.mockResolvedValue(new Map());
  h.feed.mockResolvedValue({ underlying: "AMD", proxyAddress: FEED, assetName: "Advanced Micro Devices (Coinbase Tokenized Equity)", decimals: 8 });
  h.readings.mockImplementation(async () => price());
  h.client.getBlockNumber.mockResolvedValue(52_000_000n);
  h.client.getContractEvents.mockResolvedValue([]);
  h.client.getTransaction.mockResolvedValue({ from: CREATOR });
  h.client.readContract.mockResolvedValue([10n ** 18n, false]);
  h.client.multicall.mockResolvedValue([ok("AMDc"), ok(47_00000000n), ok(true), ok(false), ok(8)]);
});

describe("stocks become visible when supply, liquidity and routes are ready", () => {
  it("keeps an old listing pending, then publishes it when liquidity arrives without Chainlink", async () => {
    h.feed.mockResolvedValue(null);
    h.markets.mockResolvedValue(new Map());
    await syncDiscoveredAssets({ lookbackBlocks: 0n });
    expect(h.rows[0].verification).toBe("discovered");
    expect(discoveredEntries()).toEqual([]);
    expect(h.client.readContract).not.toHaveBeenCalled();
    h.markets.mockResolvedValue(new Map([[AMD.toLowerCase(), { primaryPool: FEED, priceUsd: 100, liquidityUsd: 5000, updatedAt: Date.now() }]]));
    await syncDiscoveredAssets({ lookbackBlocks: 0n });
    expect(h.rows[0]).toMatchObject({ verification: "verified", chainlinkFeed: undefined, autoVerified: true });
    expect(discoveredEntries()).toEqual([expect.objectContaining({ underlying: "AMD", chainlinkFeed: undefined })]);
    // No creation event was in the recent block window on either pass.
    expect(h.client.getContractEvents).toHaveBeenCalledTimes(2);
  });

  it("revisits a saved issuer-verified candidate if the listing API is down", async () => {
    h.rows = [pending({ creator: CREATOR })];
    h.listings.mockRejectedValue(new Error("API unavailable"));
    await syncDiscoveredAssets({ lookbackBlocks: 0n });
    expect(h.rows[0].verification).toBe("verified");
    expect(h.rows[0].blockNumber).toBe(49_000_000);
  });

  it("does not trust a saved copycat just because its ticker has a feed", async () => {
    h.rows = [pending({ creator: "0x2222222222222222222222222222222222222222" })];
    h.listings.mockResolvedValue([]);
    await syncDiscoveredAssets({ lookbackBlocks: 0n });
    expect(h.rows[0].verification).toBe("discovered");
    expect(discoveredEntries()).toEqual([]);
  });

  it("keeps the onchain event fallback when the API is unavailable", async () => {
    h.listings.mockRejectedValue(new Error("API unavailable"));
    h.client.getContractEvents.mockResolvedValue([{ args: { token: AMD, variant: 0, name: listing.name, symbol: "AMDc" }, blockNumber: 52_000_000n, transactionHash: `0x${"a".repeat(64)}` }]);
    expect((await discoverNewAssets(0n))[0].eligible).toBe(true);
  });

  it.each([
    ["missing", () => new Map()],
    ["zero price", () => price(0n)],
    ["negative price", () => price(-1n)],
    ["no published timestamp", () => price(100n, 0n)],
    ["future timestamp", () => price(100n, BigInt(Math.floor(Date.now() / 1000) + 3600))],
    ["stale", () => price(100n, BigInt(Math.floor(Date.now() / 1000) - 14 * 86400))],
  ])("still publishes a liquid stock when Chainlink has %s data", async (_name, readings) => {
    h.readings.mockImplementation(async () => readings());
    await syncDiscoveredAssets({ lookbackBlocks: 0n });
    expect(h.rows[0].verification).toBe("verified");
    expect(discoveredEntries()).toHaveLength(1);
  });

  it("does not confuse a frozen reference with paused transfers", async () => {
    h.client.readContract.mockResolvedValue([10n ** 18n, true]);
    expect((await discoverNewAssets(0n))[0].eligible).toBe(true);
  });

  it.each([
    ["wrong symbol", [ok("NVDAc"), ok(47n), ok(true), ok(false), ok(8)]],
    ["zero supply", [ok("AMDc"), ok(0n), ok(true), ok(false), ok(8)]],
    ["not B20", [ok("AMDc"), ok(47n), ok(false), ok(false), ok(8)]],
    ["paused transfers", [ok("AMDc"), ok(47n), ok(true), ok(true), ok(8)]],
    ["unknown decimals", [ok("AMDc"), ok(47n), ok(true), ok(false), { status: "failure" }]],
    ["RPC failure", []],
  ])("rejects %s onchain", async (_name, results) => {
    h.client.multicall.mockResolvedValue(results);
    expect((await discoverNewAssets(0n))[0].eligible).toBe(false);
  });

  it("waits for a two-way route even when liquidity exists", async () => {
    h.routes.mockResolvedValue(false);
    await syncDiscoveredAssets({ lookbackBlocks: 0n });
    expect(h.rows[0]).toMatchObject({ verification: "discovered", reason: "no confirmed two-way USDC swap route" });
    h.routes.mockResolvedValue(true);
    await syncDiscoveredAssets({ lookbackBlocks: 0n });
    expect(h.rows[0].verification).toBe("verified");
  });

  it("attaches a newly published optional feed to an already verified stock", async () => {
    h.rows = [pending({ verification: "verified" })];
    await syncDiscoveredAssets({ lookbackBlocks: 0n });
    expect(discoveredEntries()[0].chainlinkFeed).toBe(FEED);
  });

  it("does not duplicate a ticker already verified by another server", async () => {
    h.rows = [pending({ address: "0xb200000000000000000000111111111111111111", verification: "verified", chainlinkFeed: FEED })];
    expect((await discoverNewAssets(0n))[0].eligible).toBe(false);
  });

  it("keeps a previously verified stock during a directory outage", async () => {
    h.rows = [pending({ verification: "verified", chainlinkFeed: FEED })];
    h.feed.mockResolvedValue(null);
    await syncDiscoveredAssets({ lookbackBlocks: 0n });
    expect(h.rows[0].chainlinkFeed).toBe(FEED);
    expect(discoveredEntries()).toHaveLength(1);
  });

  it("cannot reactivate a stock disabled concurrently with automatic promotion", async () => {
    h.rows = [pending()];
    h.beforePromote.mockImplementation(() => { h.rows[0].verification = "disabled"; });
    await syncDiscoveredAssets({ lookbackBlocks: 0n });
    expect(h.rows[0].verification).toBe("disabled");
    expect(discoveredEntries()).toEqual([]);
  });

  it("honours an admin-disabled stock even after liquidity is ready", async () => {
    h.rows = [pending({ verification: "disabled" })];
    await syncDiscoveredAssets({ lookbackBlocks: 0n });
    expect(h.rows[0].verification).toBe("disabled");
    expect(discoveredEntries()).toEqual([]);
  });

  it("sees a registry change made by another server on the next refresh", async () => {
    await loadDiscoveredRegistry();
    h.rows = [pending({ verification: "verified", chainlinkFeed: FEED })];
    expect(await getAsset(AMD)).toBeNull(); // Still inside the one-minute registry window.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    h.client.multicall.mockImplementation(async ({ contracts }: { contracts: Array<{ functionName: string }> }) => contracts.map(({ functionName }) => ok(({ name: listing.name, symbol: "AMDc", decimals: 8, WAD_PRECISION: 10n ** 18n, contractURI: "", policyId: 0n, extraMetadata: "US0079031078", multiplier: 10n ** 18n, isPaused: false, getOracleParams: [10n ** 18n, false], totalSupply: 47n, newUIMultiplier: 10n ** 18n, effectiveAt: 0n } as Record<string, unknown>)[functionName])));
    expect((await getAsset(AMD))?.underlying).toBe("AMD");
    vi.useRealTimers();
  });

  it("keeps the existing registry during a storage outage", async () => {
    h.rows = [pending({ verification: "verified", chainlinkFeed: FEED })];
    await loadDiscoveredRegistry(true);
    await invalidate("registry:b20:");
    h.list.mockRejectedValue(new Error("storage unavailable"));
    expect(await getAsset("0x3333333333333333333333333333333333333333")).toBeNull();
    expect(discoveredEntries()).toHaveLength(1);
  });
});

describe("reference reading when the feed cannot be read", () => {
  const liveToken = async ({ contracts }: { contracts: Array<{ functionName: string }> }) => contracts.map(({ functionName }) => ok(({ name: listing.name, symbol: "AMDc", decimals: 8, WAD_PRECISION: 10n ** 18n, contractURI: "", policyId: 0n, extraMetadata: "US0079031078", multiplier: 10n ** 18n, isPaused: false, getOracleParams: [10n ** 18n, false], totalSupply: 47n, newUIMultiplier: 10n ** 18n, effectiveAt: 0n } as Record<string, unknown>)[functionName]));

  beforeEach(async () => {
    h.rows = [pending({ verification: "verified", chainlinkFeed: FEED })];
    await loadDiscoveredRegistry(true);
    h.client.multicall.mockImplementation(liveToken);
  });

  it("takes Coinbase's copy of the same round, keeping its own timestamp", async () => {
    const updatedAt = Math.floor(Date.now() / 1000) - 600;
    h.readings.mockResolvedValue(new Map([[FEED.toLowerCase(), null]]));
    h.nav.mockResolvedValue(new Map([[AMD.toLowerCase(), { priceUsd: 613.25, updatedAt }]]));
    const asset = await getAsset(AMD);
    expect(asset?.oracle?.priceUsd).toBeCloseTo(613.25, 8);
    expect(Number(asset?.oracle?.updatedAt)).toBe(updatedAt);
    expect(asset?.oracle?.feed).toBe(FEED);
  });

  it("does not ask Coinbase when the feed answered", async () => {
    await getAsset(AMD);
    expect(h.nav).not.toHaveBeenCalled();
  });

  it("stays without a reference when both are down", async () => {
    h.readings.mockResolvedValue(new Map([[FEED.toLowerCase(), null]]));
    h.nav.mockRejectedValue(new Error("coinbase down"));
    const asset = await getAsset(AMD);
    expect(asset).not.toBeNull();
    expect(asset?.oracle).toBeUndefined();
  });
});
