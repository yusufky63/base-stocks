import { beforeEach, expect, it, vi } from "vitest";
import type { B20Asset } from "@/domain/asset";
const h = vi.hoisted(() => ({ assets: vi.fn(), markets: vi.fn(), routes: vi.fn() }));
vi.mock("./b20-asset-service", () => ({ getAssets: h.assets }));
vi.mock("./price-service", () => ({ getMarketDataMap: h.markets }));
vi.mock("@/lib/shared-store", () => ({ getSharedStore: () => null }));
vi.mock("./asset-tradability-service", async (original) => ({ ...await original<typeof import("./asset-tradability-service")>(), hasTwoWayStockRoute: h.routes }));
import { resetLastGoodMemory } from "@/lib/last-good";
import { CATALOG_GRACE_MS, getAssetCatalog, getTradableAssets } from "./stock-catalog-service";
const asset = (id: number, over: Partial<B20Asset> = {}) => ({ address: `0x${String(id).padStart(40, "0")}`, canonicalId: `0x${String(id).padStart(40, "0")}`, status: "active", verification: "verified", supplyKnown: true, totalSupply: 100n, transferPaused: false, decimals: 8, ...over }) as B20Asset;
const reading = (id: number, over: Record<string, unknown> = {}) => [asset(id).canonicalId, { priceUsd: 100, liquidityUsd: 1000, primaryPool: asset(id).address, updatedAt: Date.now(), ...over }] as const;
beforeEach(() => { vi.useRealTimers(); vi.clearAllMocks(); resetLastGoodMemory(); h.routes.mockResolvedValue(true); });
it("lists only issued, unpaused liquid assets with both trade routes, without needing an oracle", async () => {
  const assets = [asset(1), asset(2, { totalSupply: 0n }), asset(3, { transferPaused: true }), asset(4, { supplyKnown: false }), asset(5), asset(6), asset(7), asset(8, { verification: "disabled" }), asset(9, { status: "unknown" })];
  h.assets.mockResolvedValue(assets);
  h.markets.mockResolvedValue(new Map([1, 5, 6].map((id) => [asset(id).canonicalId, { priceUsd: 100, liquidityUsd: id === 5 ? 1 : 1000, primaryPool: asset(id).address, updatedAt: Date.now() }])));
  h.routes.mockImplementation(async (address) => address !== asset(6).address);
  expect(await getTradableAssets()).toEqual([assets[0]]);
  // The identity registry is untouched, preserving assets needed for wallet balances/history.
  expect(assets).toHaveLength(9);
  expect(h.routes).toHaveBeenCalledTimes(2);
});
it("removes a stock after confirmed liquidity loss and includes it again when depth returns", async () => {
  h.assets.mockResolvedValue([asset(1)]);
  const markets = new Map([[asset(1).canonicalId, { priceUsd: 100, liquidityUsd: 1000, primaryPool: asset(1).address, updatedAt: Date.now() }]]);
  h.markets.mockResolvedValue(markets);
  expect(await getTradableAssets()).toHaveLength(1);
  markets.get(asset(1).canonicalId)!.liquidityUsd = 0;
  expect(await getTradableAssets()).toEqual([]);
  markets.get(asset(1).canonicalId)!.liquidityUsd = 1000;
  expect(await getTradableAssets()).toHaveLength(1);
});
it("keeps a confirmed stock listed through a provider miss, a stale snapshot and a failed probe", async () => {
  h.assets.mockResolvedValue([asset(1), asset(2), asset(3)]);
  h.markets.mockResolvedValue(new Map([reading(1), reading(2), reading(3)]));
  expect(await getTradableAssets()).toHaveLength(3);
  // 1: the provider returned nothing; 2: only a last-good reading; 3: every quote provider failed.
  h.markets.mockResolvedValue(new Map([reading(2, { updatedAt: Date.now() - 20 * 60_000 }), reading(3)]));
  h.routes.mockImplementation(async (address) => address !== asset(3).address);
  expect(await getTradableAssets()).toHaveLength(3);
});
it("drops a stock whose checks stay unconfirmed past the grace window", async () => {
  h.assets.mockResolvedValue([asset(1)]);
  h.markets.mockResolvedValue(new Map([reading(1)]));
  expect(await getTradableAssets()).toHaveLength(1);
  h.markets.mockResolvedValue(new Map());
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + CATALOG_GRACE_MS + 1_000);
  expect(await getTradableAssets()).toEqual([]);
});
it("never lists a stock that was not confirmed first", async () => {
  h.assets.mockResolvedValue([asset(1), asset(2)]);
  h.markets.mockResolvedValue(new Map([reading(2)]));
  h.routes.mockResolvedValue(false);
  expect(await getTradableAssets()).toEqual([]);
});
it("does not let the grace window bridge a pause or a supply that reads zero", async () => {
  h.assets.mockResolvedValue([asset(1), asset(2)]);
  h.markets.mockResolvedValue(new Map([reading(1), reading(2)]));
  expect(await getTradableAssets()).toHaveLength(2);
  h.assets.mockResolvedValue([asset(1, { transferPaused: true }), asset(2, { totalSupply: 0n })]);
  expect(await getTradableAssets()).toEqual([]);
});
it("answers within the probe budget when a quote provider hangs, keeping what was confirmed", async () => {
  h.assets.mockResolvedValue([asset(1)]);
  h.markets.mockResolvedValue(new Map([reading(1)]));
  expect(await getTradableAssets()).toHaveLength(1);
  vi.useFakeTimers();
  h.routes.mockImplementation(() => new Promise(() => undefined));
  const pending = getTradableAssets();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await pending).toHaveLength(1);
});
it("returns the whole registry beside the catalog, so an unlisted stock can still be looked up", async () => {
  const assets = [asset(1), asset(2, { totalSupply: 0n })];
  h.assets.mockResolvedValue(assets);
  h.markets.mockResolvedValue(new Map([reading(1)]));
  const catalog = await getAssetCatalog();
  expect(catalog.assets).toEqual(assets);
  expect([...catalog.listed]).toEqual([asset(1).canonicalId]);
});
