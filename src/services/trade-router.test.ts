import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { ExecutableQuote, IndicativeQuote, TradeProvider, TradeProviderId } from "@/domain/trade";
import { AppError } from "@/lib/errors";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const TAKER = "0xEAa823AB4C4eE00283d8ed7be713ddf8A5ba0Fac" as Address;

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

function quote(provider: TradeProviderId, buyAmount: bigint, feeWei: bigint | null): IndicativeQuote {
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
  };
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
vi.mock("@/lib/viem/server-client", () => ({
  getServerPublicClient: () => ({ getBalance: async () => heldBalance, readContract: async () => heldBalance }),
}));
vi.mock("@/providers/trading", () => ({ getTradeProviders: () => providers }));
vi.mock("./b20-guard-service", () => ({ b20Guard: { preTradeCheck: vi.fn(async () => ({ asset, warnings: ["stale oracle"] })) } }));
vi.mock("./price-service", () => ({
  getEthUsd: vi.fn(async () => 3000),
  getMarketDataMap: vi.fn(async () => new Map([[asset.canonicalId, {}]])),
  buildPriceView: vi.fn(() => ({ displayUsd: 200, displaySource: "market" })),
  impactBasis: vi.fn(() => ({ basis: "market", price: 200 })),
}));

const { tradeRouter } = await import("./trade-router");

beforeEach(() => {
  providers.length = 0;
  heldBalance = 10n ** 30n;
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
    expect(velora.error).toMatch(/above every other route/i);
  });

  it("leaves a genuinely better route alone", async () => {
    // Routers do disagree; a few percent is routing, not fiction.
    providers.push(
      provider("kyber", async () => quote("kyber", 5_100_000n, 0n)),
      provider("velora", async () => quote("velora", 5_000_000n, 0n)),
    );
    const summary = await tradeRouter.price({ side: "sell", assetAddress: NVDA, sellAmount: 1_000_000n });
    expect(summary.provider).toBe("kyber");
    expect(summary.alternatives!.find((a) => a.provider === "kyber")!.error).toBeUndefined();
  });

  it("keeps the only quote there is, having nothing to check it against", async () => {
    providers.push(provider("velora", async () => quote("velora", 6_241_114n, 0n)));
    const summary = await tradeRouter.price({ side: "sell", assetAddress: NVDA, sellAmount: 1_437_028n });
    expect(summary.provider).toBe("velora");
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
