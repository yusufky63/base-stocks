import type { PortfolioTemplate } from "@/domain/portfolio";
import type { AssetsResponse } from "@/lib/client-api";
import { tradingStatus } from "@/lib/trading-status";

export interface TemplateLiveness {
  /** Stock legs that can be bought today: issued and backed by a DEX pool with liquidity. */
  live: number;
  /** Stock legs in the template (USDC excluded). */
  total: number;
  /** Weight that can be bought today, in bps (USDC excluded). */
  tradableBps: number;
  cashBps: number;
  /** Symbols of every leg that cannot be bought today, whatever the reason. */
  waiting: string[];
  /**
   * Split by reason, because they are not the same problem and the copy should not pretend they
   * are. A not-issued stock has no supply on Base and cannot be bought at any price; an illiquid
   * one is issued and buyable, just with a pool too shallow to take size.
   */
  notIssued: string[];
  illiquid: string[];
  /** Weight held by names with no supply at all — the part of a template that simply cannot run. */
  notIssuedBps: number;
}

/** How much of a template is real today. Without market data every stock counts as waiting. */
export function templateLiveness(template: PortfolioTemplate, assets?: AssetsResponse): TemplateLiveness {
  const out: TemplateLiveness = { live: 0, total: 0, tradableBps: 0, cashBps: 0, waiting: [], notIssued: [], illiquid: [], notIssuedBps: 0 };
  for (const a of template.allocations) {
    if (a.assetAddress === "USDC") {
      out.cashBps += a.weightBps;
      continue;
    }
    out.total++;
    const asset = assets?.assets.find((x) => x.canonicalId === a.assetAddress.toLowerCase());
    const status = asset ? tradingStatus(asset, assets?.prices[asset.canonicalId]).status : "not-issued";
    const symbol = asset?.underlying ?? a.assetAddress.slice(0, 6);
    if (status === "tradable" || status === "thin") {
      out.live++;
      out.tradableBps += a.weightBps;
      continue;
    }
    out.waiting.push(symbol);
    if (status === "not-issued") {
      out.notIssued.push(symbol);
      out.notIssuedBps += a.weightBps;
    } else {
      out.illiquid.push(symbol);
    }
  }
  return out;
}

/**
 * A template is "on the shelf" when the money you put in it actually goes to work. The bar is
 * not-issued weight, not liquidity: an illiquid name is a worse fill, a not-issued one is an
 * instruction the chain cannot carry out at all, and money sits in USDC instead.
 *
 * Deliberately a rule and not a hand-edited list, so a template returns on its own the day
 * Coinbase mints what it was waiting for.
 */
export const STALLED_BPS = 1_500;

export function isStalled(template: PortfolioTemplate, assets?: AssetsResponse): boolean {
  if (!assets) return false; // no data is not evidence of a problem
  return templateLiveness(template, assets).notIssuedBps >= STALLED_BPS;
}

/** Templates that can be bought today come first; ties keep the seed order. */
export function sortTemplatesByLiveness<T extends PortfolioTemplate>(templates: T[], assets?: AssetsResponse): T[] {
  if (!assets) return templates;
  return templates
    .map((t, i) => ({ t, i, l: templateLiveness(t, assets) }))
    .sort((a, b) => b.l.tradableBps - a.l.tradableBps || b.l.live - a.l.live || a.i - b.i)
    .map((x) => x.t);
}

/** Split for the picker: what is worth offering now, and what is waiting on an issuer. */
export function partitionTemplates<T extends PortfolioTemplate>(templates: T[], assets?: AssetsResponse): { ready: T[]; stalled: T[] } {
  const sorted = sortTemplatesByLiveness(templates, assets);
  return { ready: sorted.filter((t) => !isStalled(t, assets)), stalled: sorted.filter((t) => isStalled(t, assets)) };
}
