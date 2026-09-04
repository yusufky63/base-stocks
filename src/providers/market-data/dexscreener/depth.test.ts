import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { aggregateDepth, type DexScreenerPair } from "./adapter";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const NATIVE = "0x0000000000000000000000000000000000000000";
const WT_NVDA = "0xFb5B41acdbA20a3230F84BE995173CFb98b8D6E7";
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const BLUECHIP = "0x1111111111111111111111111111111111111111";

// Real pools have distinct addresses, and the aggregate counts each one once, so the fixtures do too.
let seq = 0;
const pair = (over: { base?: string; quote?: string; liq?: number | null; vol?: number | null; chain?: string }): DexScreenerPair =>
  ({
    chainId: over.chain ?? "base",
    dexId: "aerodrome",
    pairAddress: `0xpair${seq++}`,
    baseToken: { address: over.base ?? NVDA },
    quoteToken: { address: over.quote ?? USDC },
    liquidity: { usd: over.liq === undefined ? 1000 : over.liq },
    volume: { h24: over.vol === undefined ? 500 : over.vol },
  }) as unknown as DexScreenerPair;

describe("the depth behind a token", () => {
  /** The real shape of NVDA's book on the day this was written: one deep pool and a tail of small ones. */
  it("adds up every pool the token can be sold through", () => {
    const d = aggregateDepth(
      [pair({ liq: 2_330_511, vol: 8_357_471 }), pair({ quote: WETH, liq: 127_372, vol: 748_347 }), pair({ liq: 293_684, vol: 43_495 }), pair({ quote: NATIVE, liq: 2_661, vol: 4 })],
      NVDA,
    );
    expect(d).toEqual({ liquidityUsd: 2_754_228, volume24hUsd: 9_149_317, pools: 4 });
  });

  /**
   * The competitor's number includes these. A memecoin paired against NVDAc holds real money, but
   * it is depth for the memecoin — you cannot sell NVDA into it and come out with dollars.
   */
  it("leaves out pools where the token is what you would be paid in", () => {
    const d = aggregateDepth([pair({ liq: 100_000 }), pair({ base: BLUECHIP, quote: NVDA, liq: 553_088, vol: 1_684_030 })], NVDA);
    expect(d?.liquidityUsd).toBe(100_000);
    expect(d?.pools).toBe(1);
  });

  it("leaves out a pool against a wrapped version of the same token", () => {
    const d = aggregateDepth([pair({ liq: 100_000 }), pair({ quote: WT_NVDA, liq: 3_981 })], NVDA);
    expect(d?.liquidityUsd).toBe(100_000);
  });

  it("leaves out quotes an aggregator cannot reach dollars through", () => {
    expect(aggregateDepth([pair({ liq: 100_000 }), pair({ quote: AERO, liq: 17 })], NVDA)?.liquidityUsd).toBe(100_000);
  });

  it("ignores dead and off-chain pairs", () => {
    const d = aggregateDepth([pair({ liq: 100_000 }), pair({ liq: 0 }), pair({ liq: null }), pair({ chain: "ethereum", liq: 9_000_000 })], NVDA);
    expect(d).toEqual({ liquidityUsd: 100_000, volume24hUsd: 500, pools: 1 });
  });

  /** Nothing tradable is not zero depth — it is no answer, and the caller keeps what it had. */
  it("says nothing rather than zero when no pool qualifies", () => {
    expect(aggregateDepth([], NVDA)).toBeNull();
    expect(aggregateDepth([pair({ base: BLUECHIP, quote: NVDA, liq: 553_088 })], NVDA)).toBeNull();
  });

  it("counts a missing 24h volume as nothing traded, not as a missing pool", () => {
    const d = aggregateDepth([pair({ liq: 50_000, vol: null })], NVDA);
    expect(d).toEqual({ liquidityUsd: 50_000, volume24hUsd: 0, pools: 1 });
  });
});

describe("when the long pair list forgets the deepest pool", () => {
  const primary = pair({ liq: 111_261, vol: 200_944 });
  const withAddress = (p: DexScreenerPair, addr: string) => ({ ...p, pairAddress: addr }) as DexScreenerPair;

  /**
   * The endpoint that lists every pair caps its answer at thirty and the thirty it picks move
   * around. Strategy's deepest pool dropped out of one response and the total came back at $21.8k
   * against the $121.7k actually there — thin instead of live, on a stock page that tells people
   * how much slippage to expect.
   */
  it("still counts the pair the batch endpoint already gave us", () => {
    const truncated = [withAddress(pair({ liq: 4_949, vol: 1_000 }), "0xsmall")];
    const d = aggregateDepth(truncated, NVDA, withAddress(primary, "0xdeep"));
    expect(d).toEqual({ liquidityUsd: 116_210, volume24hUsd: 201_944, pools: 2 });
  });

  it("does not count it twice when the list did include it", () => {
    const full = [withAddress(primary, "0xdeep"), withAddress(pair({ liq: 4_949, vol: 1_000 }), "0xsmall")];
    const d = aggregateDepth(full, NVDA, withAddress(primary, "0xdeep"));
    expect(d).toEqual({ liquidityUsd: 116_210, volume24hUsd: 201_944, pools: 2 });
  });

  /** A primary that would not qualify on its own merits does not get in through the back door. */
  it("does not admit a primary pair against a quote it would otherwise refuse", () => {
    const odd = withAddress(pair({ quote: WT_NVDA, liq: 900_000 }), "0xodd");
    expect(aggregateDepth([withAddress(pair({ liq: 5_000 }), "0xa")], NVDA, odd)?.liquidityUsd).toBe(5_000);
  });

  it("uses the primary alone when the list has nothing at all", () => {
    expect(aggregateDepth([], NVDA, withAddress(primary, "0xdeep"))).toEqual({ liquidityUsd: 111_261, volume24hUsd: 200_944, pools: 1 });
  });
});
