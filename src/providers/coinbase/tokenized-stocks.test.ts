import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
const h = vi.hoisted(() => ({ fetchJson: vi.fn() }));
vi.mock("@/lib/http", () => ({ fetchJson: h.fetchJson, metrics: { count: vi.fn() } }));
vi.mock("@/lib/shared-store", () => ({ getSharedStore: () => null }));
import { invalidate } from "@/lib/cache";
import { getCoinbaseNavReadings, getCoinbaseStockListings } from "./tokenized-stocks";
const AMD = "0xB2000000000000000000000d8ce462E99ee7A47B";
const token = { contract_address: AMD, symbol: "AMDc", name: "Advanced Micro Devices" };
beforeEach(async () => { await invalidate(""); vi.clearAllMocks(); });
describe("Coinbase listing identity", () => {
  it("normalizes bad API checksum casing before use in onchain batches", async () => {
    h.fetchJson.mockResolvedValue({ status: 200, data: { tokens: [token] } });
    expect(await getCoinbaseStockListings()).toEqual([{ address: getAddress(AMD.toLowerCase()), symbol: "AMDc", name: token.name }]);
  });
  it("ignores malformed and non-asset records without losing valid listings", async () => {
    h.fetchJson.mockResolvedValue({ status: 200, data: { tokens: [token, { ...token, contract_address: "0x123" }, { ...token, symbol: "FAKE" }, { ...token, contract_address: "0xb200000000000000000001111111111111111111" }, token] } });
    expect(await getCoinbaseStockListings()).toHaveLength(1);
  });
  it("rejects an upstream error or missing list instead of treating it as no stocks", async () => {
    h.fetchJson.mockResolvedValue({ status: 503, data: {} });
    await expect(getCoinbaseStockListings()).rejects.toThrow("HTTP 503");
    h.fetchJson.mockResolvedValue({ status: 200, data: {} });
    await expect(getCoinbaseStockListings()).rejects.toThrow();
  });
});
describe("Coinbase NAV readings", () => {
  it("keeps the price with the round's own timestamp and skips tokens without one", async () => {
    const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";
    h.fetchJson.mockResolvedValue({ status: 200, data: { tokens: [
      { contract_address: NVDA, symbol: "NVDAc", name: "NVIDIA", nav_price: 234.68592897, nav_price_updated_at: "2026-10-02T17:08:11Z" },
      token,
      { ...token, contract_address: "0xb200000000000000000000fd2f87532b90095211", symbol: "MUc", nav_price: 0, nav_price_updated_at: "2026-10-02T17:08:11Z" },
      { ...token, contract_address: "0xb2000000000000000000007d16372840df4dabbe", symbol: "PLTRc", nav_price: 189.2, nav_price_updated_at: "not a date" },
    ] } });
    const nav = await getCoinbaseNavReadings();
    expect([...nav.keys()]).toEqual([NVDA.toLowerCase()]);
    expect(nav.get(NVDA.toLowerCase())).toEqual({ priceUsd: 234.68592897, updatedAt: Date.parse("2026-10-02T17:08:11Z") / 1000 });
    // A bad price costs the token its reading, never its listing.
    expect((await getCoinbaseStockListings()).map((l) => l.symbol)).toEqual(["NVDAc", "AMDc", "MUc", "PLTRc"]);
  });
});
