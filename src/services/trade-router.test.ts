import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { ExecutableQuote, IndicativeQuote, TradeProvider, TradeProviderId } from "@/domain/trade";
import { AppError } from "@/lib/errors";
import { invalidate } from "@/lib/cache";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const TAKER = "0xEAa823AB4C4eE00283d8ed7be713ddf8A5ba0Fac" as Address;
const FRIEND = "0x3333333333333333333333333333333333333333" as Address;

const asset = {
  address: NVDA,
  canonicalId: NVDA.toLowerCase(),
  name: "NVIDIA",
  symbol: "NVDAc",
  underlying: "NVDA",
  decimals: 8,
  multiplier: 10n ** 18n,
  wadPrecision: 10n ** 18n,
  totalSupply: 1_000_000n,
  status: "active" as const,
  oracle: undefined,
};

function quote(provider: TradeProviderId, buyAmount: bigint, feeWei: bigint | null, extra: Partial<IndicativeQuote> = {}): IndicativeQuote {
  return {
    provider,
    sellToken: USDC,
    buyToken: NVDA,
    sellAmount: 10_000_000n,
    buyAmount,
    minBuyAmount: null,
    gas: null,
    gasPrice: null,
    totalNetworkFeeWei: feeWei,
    liquidityAvailable: true,
    allowanceTarget: USDC,
    route: [{ source: provider, proportionBps: 10_000 }],
    issues: { allowanceRequired: false, allowanceSpender: USDC, balanceInsufficient: false, simulationIncomplete: true },
    fetchedAt: Date.now(),
    ...extra,
  };
}

function executableOf(q: IndicativeQuote, to: Address = USDC): ExecutableQuote {
  return { ...q, transaction: { to, data: "0x" as const, value: 0n, gas: null, gasPrice: null }, quoteId: null, expiresAt: Date.now() + 60_000 };
}

function provider(id: TradeProviderId, indicative: () => Promise<IndicativeQuote>, executable?: () => Promise<ExecutableQuote>): TradeProvider {
  return {
    id,
    getIndicativeQuote: indicative,
    getExecutableQuote:
      executable ??
      (async () => {
        throw new AppError("PROVIDER_UNAVAILABLE", `${id}: no executable in this test`, 503);
      }),
  };
}

const providers: TradeProvider[] = [];

/** The taker's sell-side balance, as the chain would report it. */
let heldBalance = 10n ** 30n;
/** What the RPC says gas costs right now; null = the read fails. */
let gasPriceWei: bigint | null = 10n ** 9n;
vi.mock("@/lib/viem/server-client", () => ({
  getServerPublicClient: () => ({
    getBalance: async () => heldBalance,
    readContract: async () => heldBalance,
    getGasPrice: async () => {
      if (gasPriceWei === null) throw new Error("rpc down");
      return gasPriceWei;
    },
  }),
}));
/** Which contracts each route is allowed to name; null = everything in this test is known. */
let knownTarget: ((provider: TradeProviderId, address: string) => boolean) | null = null;
vi.mock("@/providers/trading", () => ({
  getTradeProviders: () => providers,
  isKnownTarget: (p: TradeProviderId, a: string | null | undefined) => (a ? (knownTarget ? knownTarget(p, a) : true) : false),
}));
vi.mock("./b20-guard-service", () => ({ b20Guard: { preTradeCheck: vi.fn(async () => ({ asset, warnings: ["stale oracle"] })) } }));
/** The stock's reference (or market) price the deviation gate measures quotes against; null = nothing to measure against. */
let basisPrice: number | null = 200;
/** What `buildPriceView` answers: the trusted display price and, when set, the pool and reference prices the impact figures split over. */
let priceView: Record<string, unknown> = { displayUsd: 200, displaySource: "market" };
vi.mock("./price-service", () => ({
  getEthUsd: vi.fn(async () => 3000),
  getMarketDataMap: vi.fn(async () => new Map([[asset.canonicalId, {}]])),
  buildPriceView: vi.fn(() => priceView),
  impactBasis: vi.fn(() => (basisPrice === null ? null : { basis: "market", price: basisPrice })),
}));

const { tradeRouter, MAX_QUOTE_DEVIATION_PCT, BEST_EXECUTION_MIN_USD, quoteDeviationPct, networkFee } = await import("./trade-router");

beforeEach(async () => {
  providers.length = 0;
  heldBalance = 10n ** 30n;
  basisPrice = 200;
  gasPriceWei = 10n ** 9n;
  knownTarget = null;
  priceView = { displayUsd: 200, displaySource: "market" };
  // The comparison is memoized for five seconds; every test asks the same question of a different field.
  await invalidate("trade.");
});

describe("trade router comparison", () => {
  it("picks the best NET output, not the biggest gross output", async () => {
    // kyber returns more tokens but burns far more gas; velora must win on net.
    providers.push(
      provider("kyber", async () => quote("kyber", 5_010_000n, 10n ** 16n)), // ~10.02 tokens, $30 fee
      provider("velora", async () => quote("velora", 5_000_000n, 10n ** 12n)), // 10 tokens, $0.003 fee
    );
    const summary = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n });
    expect(summary.provider).toBe("velora");
    expect(summary.warnings).toContain("stale oracle");
    const alts = summary.alternatives!;
    expect(alts[0]!.provider).toBe("velora");
    expect(alts[0]!.best).toBe(true);
    expect(alts.find((a) => a.provider === "kyber")!.netUsd!).toBeLessThan(alts[0]!.netUsd!);
  });

  /**
   * Only some routes report a fee. The rest were scored as if gas were free, so a route that said
   * nothing about gas beat one that honestly reported $9 of it. A reported gas figure is now priced
   * at the chain's gas price, a route that reports nothing gets a default, and both say "estimated".
   */
  it("prices gas for routes that report none, so every net is a net", async () => {
    gasPriceWei = 10n * 10n ** 9n; // 10 gwei: 300k gas = 0.003 ETH = $9 at the mocked $3000
    providers.push(
      provider("kyber", async () => quote("kyber", 5_010_000n, null, { gas: 300_000n })), // $10.02 gross, no fee reported
      provider("velora", async () => quote("velora", 5_000_000n, 0n)), // $10.00 gross, fee reported as zero
    );
    const summary = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n });
    expect(summary.provider).toBe("velora");
    const kyber = summary.alternatives!.find((a) => a.provider === "kyber")!;
    expect(kyber.estimatedNetworkFeeUsd).toBeCloseTo(9, 3);
    expect(kyber.networkFeeEstimated).toBe(true);
    expect(kyber.netUsd).toBeCloseTo(1.02, 3);
    const velora = summary.alternatives!.find((a) => a.provider === "velora")!;
    expect(velora.networkFeeEstimated).toBe(false);
    expect(velora.netUsd).toBeCloseTo(10, 6);
  });

  it("falls back to a per-route default gas when a route reports neither gas nor fee", () => {
    const q = quote("aerodrome", 5_000_000n, null);
    const fee = networkFee(q, 10n ** 9n, 3000);
    expect(fee.estimated).toBe(true);
    expect(fee.wei).toBe(220_000n * 10n ** 9n);
    expect(fee.usd).toBeCloseTo(0.00022 * 3000, 6);
    // Nothing to price it with: the fee is unknown, not zero.
    expect(networkFee(q, null, 3000)).toEqual({ wei: null, usd: null, estimated: true });
    // A reported fee is taken as is.
    expect(networkFee(quote("cow", 5_000_000n, 0n), 10n ** 9n, 3000)).toEqual({ wei: 0n, usd: 0, estimated: false });
  });

  it("ranks by raw output and never labels it dollars when the stock has no USD price", async () => {
    priceView = { displayUsd: null, displaySource: "none" };
    providers.push(
      provider("kyber", async () => quote("kyber", 5_000_000n, 0n)),
      provider("velora", async () => quote("velora", 5_100_000n, 0n)),
    );
    const summary = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n });
    expect(summary.provider).toBe("velora");
    for (const a of summary.alternatives!) {
      expect(a.netUsd).toBeNull();
      expect(a.outUsd).toBeNull();
      expect(a.buyAmount).not.toBeNull();
    }
  });

  it("reports an empty wallet whatever route wins, not only the one provider that checks", async () => {
    // Kyber, Uniswap, Velora, Aerodrome, OKX and CoW all return a hardcoded balanceInsufficient:
    // false beside simulationIncomplete: true — "I did not look". Believing it turned a plain empty
    // wallet into a bundle simulation revert with no reason attached.
    providers.push(provider("kyber", async () => quote("kyber", 5_000_000n, 0n)));
    heldBalance = 9_262_023n; // less than the 10 USDC being spent
    const summary = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n, taker: TAKER });
    expect(summary.balanceInsufficient).toBe(true);
  });

  it("does not cry poor when the wallet covers the trade", async () => {
    providers.push(provider("kyber", async () => quote("kyber", 5_000_000n, 0n)));
    heldBalance = 10_000_000n; // exactly enough
    const summary = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n, taker: TAKER });
    expect(summary.balanceInsufficient).toBe(false);
  });

  it("refuses a winner no other router can corroborate", async () => {
    // The real shape of it: selling GOOGLc, Velora quoted 6.24 USDC through a Uniswap v4 route
    // while everyone else agreed on ~4.85. Picking it set a minimum output no pool could pay, and
    // the swap reverted with nothing to explain it.
    basisPrice = 48.7; // the test quotes sell the helper's fixed 0.1 tokens: 4.87 USDC is $48.7 a token, Velora's 6.24 is +28%, inside the gate
    providers.push(
      provider("velora", async () => quote("velora", 6_241_114n, 0n)),
      provider("okx", async () => quote("okx", 4_866_352n, 0n)),
      provider("kyber", async () => quote("kyber", 4_862_061n, 0n)),
    );
    const summary = await tradeRouter.price({ side: "sell", assetAddress: NVDA, sellAmount: 1_437_028n });
    expect(summary.provider).toBe("okx");
    const velora = summary.alternatives!.find((a) => a.provider === "velora")!;
    expect(velora.best).toBe(false);
    expect(velora.buyAmount).toBeNull();
    expect(velora.error).toMatch(/above the other routes/i);
  });

  it("leaves a genuinely better route alone", async () => {
    // Routers do disagree; a few percent is routing, not fiction.
    basisPrice = 50.5; // 5.1 and 5.0 USDC for the helper's 0.1 tokens
    providers.push(
      provider("kyber", async () => quote("kyber", 5_100_000n, 0n)),
      provider("velora", async () => quote("velora", 5_000_000n, 0n)),
    );
    const summary = await tradeRouter.price({ side: "sell", assetAddress: NVDA, sellAmount: 1_000_000n });
    expect(summary.provider).toBe("kyber");
    expect(summary.alternatives!.find((a) => a.provider === "kyber")!.error).toBeUndefined();
  });

  it("keeps the only quote there is, having nothing to check it against", async () => {
    basisPrice = null;
    providers.push(provider("velora", async () => quote("velora", 6_241_114n, 0n)));
    const summary = await tradeRouter.price({ side: "sell", assetAddress: NVDA, sellAmount: 1_437_028n });
    expect(summary.provider).toBe("velora");
  });

  it("never lets a dust pool win, even when it is the only other route", async () => {
    // The Aerodrome v2 NVDAc/USDC pool holds 0.01 USDC and quotes $10 at 0.000033 tokens. With
    // only Kyber and Aerodrome answering (ETH-pay excludes CoW, the rest timed out), the old rule
    // read Kyber as "1600% above every other route", demoted it, and handed the trade to the dust.
    providers.push(
      provider("kyber", async () => quote("kyber", 5_000_000n, 0n)), // 0.05 tokens, $200 each: the stock
      provider("aerodrome", async () => quote("aerodrome", 3_292n, null)), // 0.00003292 tokens: $303,766 a token
    );
    const summary = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n });
    expect(summary.provider).toBe("kyber");
    const dust = summary.alternatives!.find((a) => a.provider === "aerodrome")!;
    expect(dust.best).toBe(false);
    expect(dust.buyAmount).toBeNull();
    expect(dust.error).toMatch(/worse than the stock's reference/i);
    expect(summary.alternatives!.find((a) => a.provider === "kyber")!.error).toBeUndefined();
  });

  it("refuses a quote far better than the reference: nothing is filling at that price", async () => {
    providers.push(
      provider("velora", async () => quote("velora", 10_000_000n, 0n)), // 0.1 tokens for $10: $100 each, half the stock
      provider("kyber", async () => quote("kyber", 5_000_000n, 0n)),
    );
    const summary = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n });
    expect(summary.provider).toBe("kyber");
    expect(summary.alternatives!.find((a) => a.provider === "velora")!.error).toMatch(/better than the stock's reference/i);
  });

  it("refuses the trade when every route is far from the reference", async () => {
    providers.push(provider("kyber", async () => quote("kyber", 2_000_000n, 0n))); // $500 a token against a $200 stock
    await expect(tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n })).rejects.toMatchObject({ code: "ROUTE_UNAVAILABLE", message: expect.stringMatching(/reference/i) });
  });

  it("demotes against the field, not down a ladder", async () => {
    // Nets of $11, $10 and $9. The old loop compared each survivor with the next one down and could
    // walk all the way to the worst quote; now the best is checked against the rest, and with two
    // left the reference decides which of them is the stock.
    providers.push(
      provider("okx", async () => quote("okx", 5_500_000n, 0n)),
      provider("kyber", async () => quote("kyber", 5_000_000n, 0n)),
      provider("velora", async () => quote("velora", 4_500_000n, 0n)),
    );
    const summary = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n });
    expect(summary.provider).toBe("kyber");
    expect(summary.alternatives!.find((a) => a.provider === "okx")!.error).toMatch(/above the other routes/i);
    expect(summary.alternatives!.find((a) => a.provider === "velora")!.error).toBeUndefined();
  });

  it("applies the gate to the firm quote the user would sign", async () => {
    providers.push(provider("aerodrome", async () => quote("aerodrome", 3_292n, null), async () => executableOf(quote("aerodrome", 3_292n, null))));
    await expect(tradeRouter.quote({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n, taker: TAKER, provider: "aerodrome", strictProvider: true })).rejects.toMatchObject({ code: "ROUTE_UNAVAILABLE", message: expect.stringMatching(/reference/i) });
  });

  it("measures deviation in the trade panel's sign convention", () => {
    expect(quoteDeviationPct("buy", 220, 200)).toBeCloseTo(10); // paying more: worse
    expect(quoteDeviationPct("sell", 220, 200)).toBeCloseTo(-10); // receiving more: better than the stock, suspicious
    expect(quoteDeviationPct("buy", 200, null)).toBeNull();
    expect(MAX_QUOTE_DEVIATION_PCT).toBe(30);
  });

  /**
   * A pool standing 5% above the stock is a premium, not impact; reporting it as "price impact"
   * made a $10 buy look like it moved the market. Impact is measured against the pool's own mid
   * when that price is trusted, and the gap to the Chainlink reference is reported beside it.
   */
  it("separates price impact (vs the pool) from the gap to the reference", async () => {
    priceView = { displayUsd: 210, displaySource: "market", marketUsd: 210, referenceUsd: 200, referenceStale: false, referencePaused: false };
    providers.push(provider("kyber", async () => quote("kyber", 5_000_000n, 0n))); // $10 for 0.05 tokens: $200 a token
    const summary = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n });
    expect(summary.priceImpactBasis).toBe("market");
    expect(summary.priceImpactPct).toBeCloseTo(((200 - 210) / 210) * 100, 6); // below the pool mid: a good fill
    expect(summary.referenceGapPct).toBeCloseTo(0, 6); // exactly the stock's price
    expect(summary.networkFeeEstimated).toBe(false);
  });

  it("reports no reference gap while the reference is stale, and measures impact against the fallback basis without a trusted pool price", async () => {
    priceView = { displayUsd: 200, displaySource: "reference", marketUsd: 260, referenceUsd: 200, referenceStale: true, referencePaused: false };
    providers.push(provider("kyber", async () => quote("kyber", 5_000_000n, 0n)));
    const summary = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n });
    expect(summary.referenceGapPct).toBeNull();
    expect(summary.priceImpactBasis).toBe("market"); // what the mocked impactBasis answers
    expect(summary.priceImpactPct).toBeCloseTo(0, 6);
  });

  it("keeps failing providers in the comparison with their error", async () => {
    providers.push(
      provider("velora", async () => quote("velora", 5_000_000n, 0n)),
      provider("okx", async () => {
        throw new AppError("PROVIDER_UNAVAILABLE", "okx: 50125", 503);
      }),
    );
    const summary = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n });
    expect(summary.provider).toBe("velora");
    const failed = summary.alternatives!.find((a) => a.provider === "okx")!;
    expect(failed.buyAmount).toBeNull();
    expect(failed.error).toContain("50125");
  });

  it("fails as ROUTE_UNAVAILABLE when every provider lacks liquidity", async () => {
    providers.push(
      provider("kyber", async () => {
        throw new AppError("ROUTE_UNAVAILABLE", "kyber: no route with enough liquidity", 409);
      }),
    );
    await expect(tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n })).rejects.toMatchObject({ code: "ROUTE_UNAVAILABLE" });
  });

  it("strictProvider refuses to fall back to anyone else", async () => {
    providers.push(provider("velora", async () => quote("velora", 5_000_000n, 0n)));
    await expect(
      tradeRouter.quote({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n, taker: USDC, provider: "cow", strictProvider: true }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("rejects dust trades before asking any provider", async () => {
    await expect(tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 1_000n })).rejects.toMatchObject({ code: "AMOUNT_TOO_SMALL" });
  });
});

describe("trade router best execution", () => {
  /** A $300 buy: over the suggestion threshold. The comparison memo keys on the amount, so each field below asks its own question. */
  const LARGE = BigInt(BEST_EXECUTION_MIN_USD + 50) * 1_000_000n;
  /** 1.5 tokens at $200: what $300 buys at the reference, so the deviation gate lets these quotes through. */
  const LARGE_OUT = 150_000_000n;

  it("moves a competitive CoW quote to the front when asked, and only then", async () => {
    // Kyber returns 0.2% more; CoW's fee is inside its price, so it reports no network fee.
    providers.push(
      provider("kyber", async () => quote("kyber", 5_010_000n, 10n ** 12n)),
      provider("cow", async () => quote("cow", 5_000_000n, 0n)),
    );
    const plain = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n });
    expect(plain.provider).toBe("kyber");
    expect(plain.execution).toEqual({ mode: "swap", applied: false, suggested: false, note: null }); // $10: nothing to suggest

    const best = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n, bestExecution: true });
    expect(best.provider).toBe("cow");
    expect(best.execution?.applied).toBe(true);
    expect(best.alternatives![0]!.provider).toBe("cow");
    expect(best.alternatives![0]!.best).toBe(true);
    expect(best.alternatives!.find((a) => a.provider === "kyber")!.best).toBe(false);
  });

  it("suggests the mode for a large trade CoW is competitive on, without applying it", async () => {
    providers.push(
      provider("kyber", async () => quote("kyber", (LARGE_OUT * 1002n) / 1000n, 10n ** 12n, { sellAmount: LARGE })),
      provider("cow", async () => quote("cow", LARGE_OUT, 0n, { sellAmount: LARGE })),
    );
    const s = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: LARGE });
    expect(s.provider).toBe("kyber");
    expect(s.execution?.suggested).toBe(true);
    expect(s.execution?.note).toMatch(/batch auction/);
  });

  it("keeps the swap when CoW is more than the tolerance behind, and says so", async () => {
    providers.push(
      provider("kyber", async () => quote("kyber", (LARGE_OUT * 1002n) / 1000n, 10n ** 12n, { sellAmount: LARGE })),
      provider("cow", async () => quote("cow", (LARGE_OUT * 97n) / 100n, 0n, { sellAmount: LARGE })), // 3.2% behind
    );
    const s = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: LARGE, bestExecution: true });
    expect(s.provider).toBe("kyber");
    expect(s.execution).toMatchObject({ mode: "best", applied: false, suggested: false });
    expect(s.execution?.note).toMatch(/below the best swap/);
    // Nothing to suggest either: the mode would not have taken the trade.
    const plain = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: LARGE });
    expect(plain.execution?.suggested).toBe(false);
  });

  it("explains a field without CoW in it", async () => {
    providers.push(
      provider("kyber", async () => quote("kyber", 5_010_000n, 10n ** 12n)),
      provider("cow", async () => {
        throw new AppError("ROUTE_UNAVAILABLE", "cow: native ETH is not a valid sell token", 409);
      }),
    );
    const s = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n, bestExecution: true });
    expect(s.provider).toBe("kyber");
    expect(s.execution?.applied).toBe(false);
    expect(s.execution?.note).toMatch(/USDC only/);
  });

  it("asks CoW first for the firm quote and lets the swap chain cover a miss", async () => {
    const seen: string[] = [];
    providers.push(
      provider(
        "kyber",
        async () => quote("kyber", 5_010_000n, 10n ** 12n),
        async () => {
          seen.push("kyber");
          return executableOf(quote("kyber", 5_010_000n, 10n ** 12n));
        },
      ),
      provider(
        "cow",
        async () => quote("cow", 5_000_000n, 0n),
        async () => {
          seen.push("cow");
          throw new AppError("PROVIDER_UNAVAILABLE", "cow: order book down", 502);
        },
      ),
    );
    const q = await tradeRouter.quote({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n, taker: TAKER, bestExecution: true });
    expect(seen[0]).toBe("cow");
    expect(q.provider).toBe("kyber");
    expect(q.execution).toMatchObject({ mode: "best", applied: false });
  });
});

describe("trade router memo", () => {
  it("answers the same question from the last five seconds without asking the providers again", async () => {
    let asked = 0;
    providers.push(
      provider("kyber", async () => {
        asked += 1;
        return quote("kyber", 5_000_000n, 0n);
      }),
    );
    const first = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n, taker: TAKER });
    const second = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n, taker: TAKER });
    expect(asked).toBe(1);
    expect(second.buyAmount).toBe(first.buyAmount);
    // Another amount, another wallet: each is a different question.
    await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 20_000_000n, taker: TAKER });
    await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n, taker: FRIEND });
    expect(asked).toBe(3);
  });

  it("does not memoize a failure", async () => {
    let asked = 0;
    providers.push(
      provider("kyber", async () => {
        asked += 1;
        if (asked === 1) throw new AppError("PROVIDER_UNAVAILABLE", "kyber: http 502", 502);
        return quote("kyber", 5_000_000n, 0n);
      }),
    );
    await expect(tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    const ok = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n });
    expect(ok.provider).toBe("kyber");
    expect(asked).toBe(2);
  });
});

describe("trade router refusals", () => {
  /** A sale pays its USDC to the wallet that sold; a recipient on a sell would route the money elsewhere. */
  it("refuses a recipient on a sell, for the price and for the firm quote", async () => {
    providers.push(provider("kyber", async () => quote("kyber", 5_000_000n, 0n), async () => executableOf(quote("kyber", 5_000_000n, 0n))));
    await expect(tradeRouter.price({ side: "sell", assetAddress: NVDA, sellAmount: 1_000_000n, taker: TAKER, recipient: FRIEND })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/recipient/i) });
    await expect(tradeRouter.quote({ side: "sell", assetAddress: NVDA, sellAmount: 1_000_000n, taker: TAKER, recipient: FRIEND })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // The seller naming themself is not a redirection.
    basisPrice = 50; // the helper sells its fixed 0.1 tokens for 5 USDC: $50 a token
    await expect(tradeRouter.price({ side: "sell", assetAddress: NVDA, sellAmount: 1_000_000n, taker: TAKER, recipient: TAKER })).resolves.toMatchObject({ provider: "kyber" });
  });

  /**
   * A quote's `to` and spender came straight out of the provider response and went straight into
   * the wallet. Each adapter now names the contracts its provider uses; anything else is refused.
   */
  it("refuses a firm quote that sends the wallet to a contract the route is not known to use", async () => {
    knownTarget = (_p, a) => a.toLowerCase() === USDC.toLowerCase();
    providers.push(provider("kyber", async () => quote("kyber", 5_000_000n, 0n), async () => executableOf(quote("kyber", 5_000_000n, 0n), NVDA)));
    await expect(tradeRouter.quote({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n, taker: TAKER, provider: "kyber", strictProvider: true })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { provider: "kyber", reason: expect.stringMatching(/transaction target/i) },
    });
  });

  it("refuses a firm quote whose spender is off the route's list", async () => {
    knownTarget = (_p, a) => a.toLowerCase() === NVDA.toLowerCase(); // the tx target is fine, the USDC spender is not
    providers.push(provider("kyber", async () => quote("kyber", 5_000_000n, 0n), async () => executableOf(quote("kyber", 5_000_000n, 0n), NVDA)));
    await expect(tradeRouter.quote({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n, taker: TAKER, provider: "kyber", strictProvider: true })).rejects.toMatchObject({
      details: { reason: expect.stringMatching(/spender/i) },
    });
  });

  it("accepts a firm quote whose contracts are all on the route's list", async () => {
    knownTarget = (_p, a) => a.toLowerCase() === USDC.toLowerCase();
    providers.push(provider("kyber", async () => quote("kyber", 5_000_000n, 0n), async () => executableOf(quote("kyber", 5_000_000n, 0n), USDC)));
    const q = await tradeRouter.quote({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n, taker: TAKER, provider: "kyber", strictProvider: true });
    expect(q.transaction?.to).toBe(USDC);
    expect(q.referenceGapPct).toBeNull(); // the default price view carries no reference
  });

  it("keeps a route naming an unknown spender out of the running in the comparison", async () => {
    knownTarget = (_p, a) => a.toLowerCase() === USDC.toLowerCase();
    providers.push(
      provider("velora", async () => quote("velora", 5_100_000n, 0n, { allowanceTarget: NVDA, issues: { allowanceRequired: false, allowanceSpender: NVDA, balanceInsufficient: false, simulationIncomplete: true } })),
      provider("kyber", async () => quote("kyber", 5_000_000n, 0n)),
    );
    const summary = await tradeRouter.price({ side: "buy", assetAddress: NVDA, sellAmount: 10_000_000n });
    expect(summary.provider).toBe("kyber");
    const velora = summary.alternatives!.find((a) => a.provider === "velora")!;
    expect(velora.buyAmount).toBeNull();
    expect(velora.error).toMatch(/recognise/i);
  });
});
