import { beforeEach, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { TokenMarketData } from "@/domain/market";
const h = vi.hoisted(() => ({ key: true, dex: vi.fn(), cg: vi.fn(), metadata: vi.fn(), candles: vi.fn() }));
vi.mock("@/config/env", () => ({ serverEnv: () => ({ COINGECKO_API_KEY: h.key ? "configured" : undefined }) }));
vi.mock("./keyless/adapter", () => ({ keylessProvider: { id: "keyless", getTokenMarkets: h.dex, getTokenMetadata: h.metadata, getTokenOhlcv: h.candles } }));
vi.mock("./coingecko/adapter", () => ({ coinGeckoProvider: { getTokenMarkets: h.cg, getTokenMetadata: vi.fn(), getTokenOhlcv: vi.fn() } }));
import { getMarketDataProvider } from "./index";
const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const market = (address: Address, source: string) => ({ address, source, priceUsd: 100, liquidityUsd: 1000, primaryPool: A, updatedAt: Date.now() }) as TokenMarketData;
beforeEach(() => { vi.clearAllMocks(); h.key = true; });
it("fills uncovered tokens without replacing a DEX snapshot", async () => {
  h.dex.mockResolvedValue(new Map([[A, market(A, "dexscreener")]]));
  h.cg.mockResolvedValue(new Map([[B, market(B, "coingecko")]]));
  const result = await getMarketDataProvider().getTokenMarkets([A, B]);
  expect(h.cg).toHaveBeenCalledWith([B]);
  expect(result.get(A)?.source).toBe("dexscreener"); expect(result.get(B)?.source).toBe("coingecko");
});
it("uses the paid fallback during a keyless outage", async () => {
  h.dex.mockRejectedValue(new Error("outage")); h.cg.mockResolvedValue(new Map([[A, market(A, "coingecko")]]));
  expect((await getMarketDataProvider().getTokenMarkets([A])).get(A)?.source).toBe("coingecko");
});
it("does not call a paid service when no key is configured", async () => {
  h.key = false; h.dex.mockResolvedValue(new Map([[A, market(A, "dexscreener")]]));
  await getMarketDataProvider().getTokenMarkets([A]); expect(h.cg).not.toHaveBeenCalled();
});
