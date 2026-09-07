import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { EarnOpportunity, EarnType } from "@/domain/earn";
import { curateUsdcVenues, rankStockVenues } from "./earn-opportunity-service";

/**
 * Which USDC venues make it onto the page.
 *
 * The old rule took the four largest vaults, which on live data hid one paying a full point more
 * than anything shown, and let through a vault whose API-reported APY was in the tens of thousands
 * of percent. Both are quiet failures — the list still renders, it is just wrong about where the
 * money should go — so the rule is pinned here.
 */
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;

function venue(id: string, type: EarnType, apy: number | undefined, tvlUsd?: number, extra: Partial<EarnOpportunity> = {}): EarnOpportunity {
  return {
    id,
    provider: type === "vault" ? "morpho" : "aave",
    assetAddress: USDC,
    type,
    title: id,
    variableApy: apy,
    tvlUsd,
    riskLabel: "medium",
    dataTimestamp: Date.now(),
    risks: [],
    inApp: true,
    metadata: {},
    ...extra,
  } as EarnOpportunity;
}

const ids = (list: EarnOpportunity[]) => list.map((o) => o.id);

describe("USDC venue curation", () => {
  it("keeps both the deepest vaults and the best-paying ones", () => {
    const out = curateUsdcVenues([
      venue("deep-1", "vault", 3.2, 400_000_000),
      venue("deep-2", "vault", 3.8, 300_000_000),
      venue("deep-3", "vault", 4.2, 130_000_000),
      venue("deep-4", "vault", 4.3, 95_000_000),
      venue("deep-5", "vault", 3.9, 20_000_000),
      venue("rich-1", "vault", 5.3, 2_500_000),
      venue("rich-2", "vault", 5.1, 800_000),
    ]);
    // The four largest by depth, plus the two that pay best; ordered by rate.
    expect(ids(out)).toEqual(["rich-1", "rich-2", "deep-4", "deep-3", "deep-2", "deep-1"]);
  });

  it("drops an APY only an upstream API could have produced", () => {
    const out = curateUsdcVenues([venue("sane", "vault", 4.2, 5_000_000), venue("absurd", "vault", 133_843, 300_000)]);
    expect(ids(out)).toEqual(["sane"]);
  });

  it("drops vaults with no rate and vaults too thin to point strangers at", () => {
    const out = curateUsdcVenues([venue("ok", "vault", 4.2, 5_000_000), venue("no-rate", "vault", undefined, 5_000_000), venue("thin", "vault", 4.9, 50_000)]);
    expect(ids(out)).toEqual(["ok"]);
  });

  it("refuses a vault Morpho has flagged red, whatever the rate says", () => {
    const red = (type: string) => venue(type, "vault", 6.5, 30_000_000, { metadata: { warnings: [{ type, level: "RED" }] } });
    const out = curateUsdcVenues([venue("ok", "vault", 4.2, 5_000_000), red("deposit_disabled"), red("deprecated"), red("short_timelock")]);
    expect(ids(out)).toEqual(["ok"]);
  });

  it("keeps an amber flag on the page, since it qualifies a vault rather than disqualifying it", () => {
    const amber = venue("amber", "vault", 4.9, 90_000_000, { metadata: { warnings: [{ type: "not_whitelisted", level: "YELLOW" }] } });
    expect(ids(curateUsdcVenues([amber]))).toEqual(["amber"]);
  });

  it("refuses a vault whose deposits cannot be withdrawn, flagged or not", () => {
    const stuck = venue("stuck", "vault", 8.1, 40_000_000, { metadata: { withdrawableUsd: 150_000 } }); // 0.4% available
    const open = venue("open", "vault", 4.0, 40_000_000, { metadata: { withdrawableUsd: 20_000_000 } });
    expect(ids(curateUsdcVenues([stuck, open]))).toEqual(["open"]);
  });

  it("does not treat a missing liquidity figure as a blocked exit", () => {
    const out = curateUsdcVenues([venue("no-figure", "vault", 4.2, 5_000_000, { metadata: {} })]);
    expect(ids(out)).toEqual(["no-figure"]);
  });

  it("leaves out borrowing and liquidity — a different bargain, and each has its own section", () => {
    const out = curateUsdcVenues([venue("supply", "supply", 3.7), venue("borrow", "borrow", 6.1), venue("pool", "liquidity", 30, 1_000_000)]);
    expect(ids(out)).toEqual(["supply"]);
  });

  it("keeps a venue that has to be finished in its own interface, rather than hiding it", () => {
    const out = curateUsdcVenues([venue("in-app", "supply", 3.7), venue("elsewhere", "supply", 5.5, undefined, { inApp: false, url: "https://example.org" })]);
    expect(ids(out)).toEqual(["elsewhere", "in-app"]);
  });

  it("never lets the lending markets fall out, however many vaults there are", () => {
    const vaults = Array.from({ length: 12 }, (_, i) => venue(`v${i}`, "vault", 4 + i / 10, 1_000_000 * (i + 1)));
    const out = curateUsdcVenues([venue("aave", "supply", 3.7), ...vaults]);
    expect(out.some((o) => o.id === "aave")).toBe(true);
    // Four for depth, four for rate, one overlap between them, plus the market.
    expect(out.length).toBeLessThanOrEqual(1 + 8);
  });
});

/**
 * Which stock pools are worth putting in front of somebody, and in what order.
 *
 * Ranking by depth alone put a stock paired against a memecoin above a deeper stock/USDC pool, and
 * the list carried pools holding a few hundred dollars whose headline APY was an artefact of their
 * own thinness. Both read as recommendations, so the grading is pinned.
 */
const NVDA = "0xb200000000000000000000000000000000000001" as Address;
const AAPL = "0xb200000000000000000000000000000000000002" as Address;
const STOCKS = new Set([NVDA.toLowerCase(), AAPL.toLowerCase()]);

function pool(id: string, asset: Address, quote: string | undefined, liquidityUsd: number): EarnOpportunity {
  return {
    id,
    provider: "aerodrome",
    assetAddress: asset,
    type: "liquidity",
    title: id,
    liquidityUsd,
    riskLabel: "higher",
    dataTimestamp: Date.now(),
    risks: [],
    inApp: false,
    metadata: quote === undefined ? {} : { quote },
  } as EarnOpportunity;
}

describe("stock venue ranking", () => {
  it("grades by what the stock is paired against before depth", () => {
    const out = rankStockVenues(
      [pool("memecoin-deep", NVDA, "BOX", 500_000), pool("weth-mid", NVDA, "WETH", 200_000), pool("usdc-shallow", NVDA, "USDC", 100_000)],
      STOCKS,
    );
    expect(ids(out)).toEqual(["usdc-shallow", "weth-mid", "memecoin-deep"]);
  });

  it("orders by depth within one quote asset", () => {
    const out = rankStockVenues([pool("small", NVDA, "USDC", 50_000), pool("deep", AAPL, "USDC", 2_000_000), pool("mid", NVDA, "USDC", 400_000)], STOCKS);
    expect(ids(out)).toEqual(["deep", "mid", "small"]);
  });

  it("drops pools too thin to join", () => {
    const out = rankStockVenues([pool("real", NVDA, "USDC", 25_000), pool("dust", NVDA, "USDC", 446), pool("edge", AAPL, "USDC", 9_999)], STOCKS);
    expect(ids(out)).toEqual(["real"]);
  });

  it("treats an unknown quote as the riskiest rather than the safest", () => {
    const out = rankStockVenues([pool("unknown-quote", NVDA, undefined, 900_000), pool("usdc", AAPL, "USDC", 20_000)], STOCKS);
    expect(ids(out)).toEqual(["usdc", "unknown-quote"]);
  });

  it("refuses anything that is not a pool on a listed stock", () => {
    const notAStock = "0x4200000000000000000000000000000000000006" as Address;
    const out = rankStockVenues([pool("eth-usdc", notAStock, "USDC", 50_000_000), pool("nvda-usdc", NVDA, "USDC", 20_000)], STOCKS);
    expect(ids(out)).toEqual(["nvda-usdc"]);
  });
});
