import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { EarnOpportunity, EarnType } from "@/domain/earn";
import { curateUsdcVenues } from "./earn-opportunity-service";

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
