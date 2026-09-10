import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { B20Asset, OracleState } from "@/domain/asset";
import type { TokenMarketData } from "@/domain/market";
import { buildPriceView } from "./price-service";

const TSLA = "0xb2000000000000000000001e800a7f5189430cD0" as Address;

function oracle(priceUsd: number, over: Partial<OracleState> = {}): OracleState {
  return {
    feed: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4" as Address,
    answer: BigInt(Math.round(priceUsd * 1e8)),
    updatedAt: BigInt(Math.floor(Date.now() / 1000)),
    decimals: 8,
    paused: false,
    stale: false,
    staleAfterSeconds: 90_000,
    freshness: "live",
    marketOpen: true,
    priceUsd,
    ...over,
  };
}

function asset(over: Partial<B20Asset> = {}): B20Asset {
  return {
    address: TSLA,
    canonicalId: TSLA.toLowerCase(),
    underlying: "TSLA",
    oracle: oracle(366.27),
    ...over,
  } as B20Asset;
}

function market(priceUsd: number, liquidityUsd: number): TokenMarketData {
  return {
    address: TSLA,
    priceUsd,
    change24hPct: null,
    volume24hUsd: null,
    liquidityUsd,
    marketCapUsd: null,
    source: "dexscreener",
    updatedAt: Date.now(),
  } as TokenMarketData;
}

/**
 * Base's own guidance is what shapes this gate. The Chainlink feed is sourced from traditional
 * equity market data, and "the token's DEX price does not feed the oracle", so the reference is the
 * one number nobody can move by opening a pool. A market price earns the headline by agreeing with
 * it, and by nothing else.
 */
describe("buildPriceView display gate", () => {
  it("shows the market price when it agrees with the reference", () => {
    const view = buildPriceView(asset(), market(365.73, 709_888));
    expect(view.displaySource).toBe("market");
    expect(view.displayUsd).toBe(365.73);
  });

  /**
   * The TSLAc case, 2026-09-10. The gate used to be a chain of `||`, so $717k of liquidity satisfied
   * it on its own and the deviation was never consulted. The page showed $17,936 beside a reference
   * of $366, marked Live, and multiplied every holder's portfolio by 49.
   */
  it("refuses a market price 49x away from the reference, however deep the pool", () => {
    const view = buildPriceView(asset(), market(17_936.63, 717_214));
    expect(view.displaySource).toBe("reference");
    expect(view.displayUsd).toBe(366.27);
    // Kept for transparency: the page can still say what the pool quoted, and how far out it is.
    expect(view.marketUsd).toBe(17_936.63);
    expect(Math.round(view.deviationPct ?? 0)).toBe(4797);
  });

  it("refuses a market price off a pool too thin to be a market", () => {
    expect(buildPriceView(asset(), market(366.0, 500)).displaySource).toBe("reference");
  });

  /**
   * Off-hours the feed holds its last value while the DEX keeps trading, so there is nothing
   * meaningful to check against and refusing the market price would leave the page blank. The check
   * applies exactly when it can mean something.
   */
  it("falls back to the market price when the reference is frozen or stale", () => {
    const frozen = asset({ oracle: oracle(366.27, { paused: true, freshness: "frozen" }) });
    expect(buildPriceView(frozen, market(400, 709_888)).displaySource).toBe("market");

    const stale = asset({ oracle: oracle(366.27, { stale: true, freshness: "stale" }) });
    expect(buildPriceView(stale, market(400, 709_888)).displaySource).toBe("market");
  });

  it("shows the reference when there is no market at all, and nothing when there is neither", () => {
    expect(buildPriceView(asset(), null).displaySource).toBe("reference");
    expect(buildPriceView(asset({ oracle: undefined }), null).displaySource).toBe("none");
  });

  it("still shows a market price for a stock with no oracle to check against", () => {
    const view = buildPriceView(asset({ oracle: undefined }), market(12.5, 30_000));
    expect(view.displaySource).toBe("market");
    expect(view.displayUsd).toBe(12.5);
  });
});
