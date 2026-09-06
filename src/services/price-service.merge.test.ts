import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { TokenMarketData } from "@/domain/market";
import { mergeMarketData } from "./price-service";

const AAPL = "0xb200000000000000000000C2e324d24d7eEcd1fb" as Address;
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
const HOUR = 3600_000;

const row = (address: Address, liquidityUsd: number, updatedAt: number): TokenMarketData => ({ address, priceUsd: 100, change24hPct: 1, volume24hUsd: 10, liquidityUsd, marketCapUsd: null, source: "dexscreener", updatedAt });
const map = (...rows: TokenMarketData[]) => new Map(rows.map((r) => [r.address.toLowerCase(), r]));

/**
 * The bug this covers: both providers answering nothing for a minute turned every stock into
 * "No pool" and the counters into "0 live". A miss is a miss, not a market with no pools.
 */
describe("market data across a bad minute upstream", () => {
  it("serves the last good reading for a token the fresh batch missed", () => {
    const good = map(row(AAPL, 1_400_000, NOW - 5 * 60_000), row(NVDA, 3_300_000, NOW - 5 * 60_000));
    const merged = mergeMarketData([AAPL, NVDA], map(row(NVDA, 3_310_000, NOW)), good, NOW);
    expect(merged.get(NVDA.toLowerCase())?.liquidityUsd).toBe(3_310_000);
    expect(merged.get(AAPL.toLowerCase())?.liquidityUsd).toBe(1_400_000);
    // The kept reading keeps its own time, so nothing pretends to be fresher than it is.
    expect(merged.get(AAPL.toLowerCase())?.updatedAt).toBe(NOW - 5 * 60_000);
  });

  it("serves everything from the last good batch when the fresh one is empty", () => {
    const good = map(row(AAPL, 1_400_000, NOW - 2 * HOUR), row(NVDA, 3_300_000, NOW - 2 * HOUR));
    const merged = mergeMarketData([AAPL, NVDA], new Map(), good, NOW);
    expect(merged.size).toBe(2);
  });

  /** A reading older than a day is dropped rather than shown as today's liquidity. */
  it("lets a last good reading expire after a day", () => {
    const good = map(row(AAPL, 1_400_000, NOW - 25 * HOUR));
    expect(mergeMarketData([AAPL], new Map(), good, NOW).size).toBe(0);
    expect(mergeMarketData([AAPL], new Map(), map(row(AAPL, 1_400_000, NOW - 23 * HOUR)), NOW).size).toBe(1);
  });

  it("is empty only when nothing was ever known", () => {
    expect(mergeMarketData([AAPL, NVDA], new Map(), null, NOW).size).toBe(0);
  });
});
