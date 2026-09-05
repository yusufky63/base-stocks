import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { PortfolioSnapshot } from "@/domain/portfolio";
import { currentMix, driftBase, driftRows, driftSummary, maxDriftBps } from "./drift";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const AAPL = "0xb200000000000000000000C2e324d24d7eEcd1fb" as Address;
const META = "0xb2000000000000000000008bC8786B856E61707C" as Address;

function snapshot(holdings: Array<{ assetAddress: Address; marketValueUsd: number; underlying?: string }>, usdcValueUsd = 0): Pick<PortfolioSnapshot, "holdings" | "usdcValueUsd"> {
  return { holdings: holdings.map((h) => ({ ...h, underlying: h.underlying ?? "X" })) as PortfolioSnapshot["holdings"], usdcValueUsd };
}

const fifty = [
  { assetAddress: NVDA, weightBps: 5000 },
  { assetAddress: AAPL, weightBps: 5000 },
];

describe("the base a target is measured against", () => {
  it("is the stocks alone for a stock-only target", () => {
    expect(driftBase(snapshot([{ assetAddress: NVDA, marketValueUsd: 600 }], 400), fifty)).toBe(600);
  });

  it("includes cash only when the target holds cash", () => {
    const withCash = [...fifty.map((a) => ({ ...a, weightBps: 4000 })), { assetAddress: "USDC" as const, weightBps: 2000 }];
    expect(driftBase(snapshot([{ assetAddress: NVDA, marketValueUsd: 600 }], 400), withCash)).toBe(1000);
  });
});

describe("the banner and the table agree", () => {
  /** The bug this pins: saving today's mix used to leave the table proposing to spend every dollar of cash. */
  it("reads zero drift right after saving today's mix, cash or no cash", () => {
    const s = snapshot(
      [
        { assetAddress: NVDA, marketValueUsd: 600 },
        { assetAddress: AAPL, marketValueUsd: 400 },
      ],
      500,
    );
    const mix = currentMix(s);
    expect(mix).toEqual([
      { assetAddress: NVDA, weightBps: 6000 },
      { assetAddress: AAPL, weightBps: 4000 },
    ]);
    expect(maxDriftBps(s, mix)).toBe(0);
    const rows = driftRows(s, mix);
    expect(rows.every((r) => r.action === "hold")).toBe(true);
    expect(rows.some((r) => r.assetAddress === "USDC")).toBe(false);
    expect(driftSummary(s, mix, rows).inBalance).toBe(true);
  });

  it("proposes the same legs the banner counts", () => {
    const s = snapshot(
      [
        { assetAddress: NVDA, marketValueUsd: 700, underlying: "NVDA" },
        { assetAddress: AAPL, marketValueUsd: 300, underlying: "AAPL" },
      ],
      100,
    );
    expect(maxDriftBps(s, fifty)).toBe(2000);
    const rows = driftRows(s, fifty);
    const nvda = rows.find((r) => r.symbol === "NVDA")!;
    const aapl = rows.find((r) => r.symbol === "AAPL")!;
    expect(nvda.action).toBe("sell");
    expect(nvda.deltaUsd).toBeCloseTo(-200);
    expect(aapl.action).toBe("buy");
    expect(aapl.deltaUsd).toBeCloseTo(200);
    const summary = driftSummary(s, fifty, rows);
    expect(summary.sellsUsd).toBeCloseTo(200);
    expect(summary.buysUsd).toBeCloseTo(200);
    expect(summary.shortfallUsd).toBe(0);
    expect(summary.trades).toBe(2);
  });
});

describe("a template with a cash share", () => {
  const balanced = [
    { assetAddress: NVDA, weightBps: 4000 },
    { assetAddress: AAPL, weightBps: 4000 },
    { assetAddress: "USDC" as const, weightBps: 2000 },
  ];

  /** The bug this pins: a cash leg used to be skipped by the banner but charged by the table. */
  it("is in balance when the wallet matches it, cash included", () => {
    const s = snapshot(
      [
        { assetAddress: NVDA, marketValueUsd: 400 },
        { assetAddress: AAPL, marketValueUsd: 400 },
      ],
      200,
    );
    expect(maxDriftBps(s, balanced)).toBe(0);
    expect(driftRows(s, balanced).every((r) => r.action === "hold")).toBe(true);
  });

  it("says cash is spent or kept, never sold", () => {
    const s = snapshot(
      [
        { assetAddress: NVDA, marketValueUsd: 400 },
        { assetAddress: AAPL, marketValueUsd: 200 },
      ],
      400,
    );
    const rows = driftRows(s, balanced);
    const cash = rows.find((r) => r.assetAddress === "USDC")!;
    expect(cash.action).toBe("spend");
    expect(cash.deltaUsd).toBeCloseTo(-200);
    expect(rows.find((r) => r.assetAddress === AAPL)!.action).toBe("buy");
  });
});

describe("what counts as out of line", () => {
  it("holds legs inside the minimum, in dollars and in share", () => {
    const s = snapshot(
      [
        { assetAddress: NVDA, marketValueUsd: 504 },
        { assetAddress: AAPL, marketValueUsd: 496 },
      ],
      0,
    );
    expect(driftRows(s, fifty).every((r) => r.action === "hold")).toBe(true);
    const big = snapshot(
      [
        { assetAddress: NVDA, marketValueUsd: 50_400 },
        { assetAddress: AAPL, marketValueUsd: 49_600 },
      ],
      0,
    );
    // $400 out on $100k is 0.4%: below the 1% line even though it is well above $5.
    expect(driftRows(big, fifty).every((r) => r.action === "hold")).toBe(true);
  });

  it("counts a stock held outside the target as fully drifted", () => {
    const s = snapshot(
      [
        { assetAddress: NVDA, marketValueUsd: 500 },
        { assetAddress: AAPL, marketValueUsd: 500 },
        { assetAddress: META, marketValueUsd: 1000, underlying: "META" },
      ],
      0,
    );
    expect(maxDriftBps(s, fifty)).toBe(5000);
    const meta = driftRows(s, fifty).find((r) => r.symbol === "META")!;
    expect(meta.action).toBe("sell");
    expect(meta.targetBps).toBe(0);
  });

  it("marks a leg that cannot trade today and leaves it out of the totals", () => {
    const s = snapshot(
      [
        { assetAddress: NVDA, marketValueUsd: 1000, underlying: "NVDA" },
      ],
      0,
    );
    const rows = driftRows(s, fifty, { symbolFor: () => "AAPL", blockedFor: (side, addr) => (addr === AAPL.toLowerCase() ? "not issued on Base yet" : null) });
    const aapl = rows.find((r) => r.symbol === "AAPL")!;
    expect(aapl.action).toBe("buy");
    expect(aapl.blocked).toBe("not issued on Base yet");
    const summary = driftSummary(s, fifty, rows);
    expect(summary.buysUsd).toBe(0);
    expect(summary.blockedUsd).toBeCloseTo(500);
    expect(summary.trades).toBe(1);
  });

  it("has nothing to say without a target or without holdings", () => {
    expect(maxDriftBps(snapshot([{ assetAddress: NVDA, marketValueUsd: 100 }]), null)).toBeNull();
    expect(maxDriftBps(snapshot([{ assetAddress: NVDA, marketValueUsd: 100 }]), [])).toBeNull();
    expect(maxDriftBps(snapshot([]), fifty)).toBeNull();
    expect(driftRows(snapshot([]), fifty)).toEqual([]);
  });
});
