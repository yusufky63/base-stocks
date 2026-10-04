import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { TokenMarketData } from "@/domain/market";
import type { TradeIntent } from "@/domain/trade";
const h = vi.hoisted(() => ({ primary: vi.fn(), fallback: vi.fn(), providers: vi.fn() }));
vi.mock("@/providers/trading", () => ({ getTradeProviders: h.providers }));
vi.mock("@/lib/shared-store", () => ({ getSharedStore: () => null }));
import { invalidate } from "@/lib/cache";
import { hasTwoWayStockRoute, marketListingBlockedReason, MIN_LISTING_LIQUIDITY_USD } from "./asset-tradability-service";
const ASSET = "0xb2000000000000000000000d8ce462e99ee7a47b" as Address;
const market = (over: Partial<TokenMarketData> = {}): TokenMarketData => ({ address: ASSET, priceUsd: 100, liquidityUsd: 1000, volume24hUsd: 10, change24hPct: 1, marketCapUsd: null, source: "dexscreener", updatedAt: Date.now(), primaryPool: ASSET, ...over });
const quote = (intent: TradeIntent) => ({ ...intent, liquidityAvailable: true, buyAmount: intent.side === "buy" ? 1_000_000n : 990_000n });
beforeEach(async () => {
  vi.useRealTimers(); vi.clearAllMocks(); await invalidate("");
  h.providers.mockReturnValue([{ getIndicativeQuote: h.primary }, { getIndicativeQuote: h.fallback }]);
  h.primary.mockImplementation(async (intent: TradeIntent) => quote(intent));
  h.fallback.mockImplementation(async (intent: TradeIntent) => quote(intent));
});
describe("market eligibility", () => {
  it("uses the existing minimum trade and maximum leg share", () => { expect(MIN_LISTING_LIQUIDITY_USD).toBe(50); expect(marketListingBlockedReason(market({ liquidityUsd: 50 }))).toBeNull(); });
  it.each([
    ["no pool", { primaryPool: undefined }], ["dust pool", { liquidityUsd: 1 }], ["empty pool", { liquidityUsd: 0 }],
    ["unknown depth", { liquidityUsd: null }], ["bad depth", { liquidityUsd: Infinity }], ["no price", { priceUsd: null }], ["negative price", { priceUsd: -1 }],
    ["stale snapshot", { updatedAt: Date.now() - 301_000 }], ["future snapshot", { updatedAt: Date.now() + 100_000 }],
  ])("rejects %s", (_label, over) => { expect(marketListingBlockedReason(market(over))).not.toBeNull(); });
});
describe("read-only route checks", () => {
  it("checks a minimum buy and selling its output, then shares the cached result", async () => {
    expect(await hasTwoWayStockRoute(ASSET, 8)).toBe(true);
    expect(h.primary).toHaveBeenCalledTimes(2);
    expect(h.primary.mock.calls[0][0]).toMatchObject({ side: "buy", sellAmount: 1_000_000n, buyToken: ASSET });
    expect(h.primary.mock.calls[1][0]).toMatchObject({ side: "sell", sellAmount: 1_000_000n, sellToken: ASSET });
    expect(h.providers).toHaveBeenCalledWith({ orders: false, zeroX: false });
    expect(await hasTwoWayStockRoute(ASSET, 8)).toBe(true);
    expect(h.primary).toHaveBeenCalledTimes(2);
  });
  it("tries an alternative route when the first provider is unavailable", async () => {
    h.primary.mockRejectedValue(new Error("unavailable"));
    expect(await hasTwoWayStockRoute(ASSET, 8)).toBe(true);
    expect(h.fallback).toHaveBeenCalledTimes(2);
  });
  it("refuses buy-only pools and retries a negative result after one minute", async () => {
    const buyOnly = async (intent: TradeIntent) => { if (intent.side === "sell") throw new Error("no sell route"); return quote(intent); };
    h.primary.mockImplementation(buyOnly); h.fallback.mockImplementation(buyOnly);
    expect(await hasTwoWayStockRoute(ASSET, 8)).toBe(false);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 61_000);
    h.primary.mockImplementation(async (intent: TradeIntent) => quote(intent));
    expect(await hasTwoWayStockRoute(ASSET, 8)).toBe(true);
  });
  it.each(["zero output", "wrong token", "wrong amount", "no liquidity"])("refuses %s from every provider", async (problem) => {
    const bad = async (intent: TradeIntent) => ({ ...quote(intent), ...(problem === "zero output" ? { buyAmount: 0n } : problem === "wrong token" ? { buyToken: "0x1111111111111111111111111111111111111111" } : problem === "wrong amount" ? { sellAmount: 1n } : { liquidityAvailable: false }) });
    h.primary.mockImplementation(bad); h.fallback.mockImplementation(bad);
    expect(await hasTwoWayStockRoute(ASSET, 8)).toBe(false);
  });
});
