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
  /** Symbols of the legs that wait for issuance or a pool; they stay as USDC in a plan. */
  waiting: string[];
}

/** How much of a template is real today. Without market data every stock counts as waiting. */
export function templateLiveness(template: PortfolioTemplate, assets?: AssetsResponse): TemplateLiveness {
  const out: TemplateLiveness = { live: 0, total: 0, tradableBps: 0, cashBps: 0, waiting: [] };
  for (const a of template.allocations) {
    if (a.assetAddress === "USDC") {
      out.cashBps += a.weightBps;
      continue;
    }
    out.total++;
    const asset = assets?.assets.find((x) => x.canonicalId === a.assetAddress.toLowerCase());
    const status = asset ? tradingStatus(asset, assets?.prices[asset.canonicalId]).status : "not-issued";
    if (status === "tradable" || status === "thin") {
      out.live++;
      out.tradableBps += a.weightBps;
    } else {
      out.waiting.push(asset?.underlying ?? a.assetAddress.slice(0, 6));
    }
  }
  return out;
}

/** Templates that can be bought today come first; ties keep the seed order. */
export function sortTemplatesByLiveness<T extends PortfolioTemplate>(templates: T[], assets?: AssetsResponse): T[] {
  if (!assets) return templates;
  return templates
    .map((t, i) => ({ t, i, l: templateLiveness(t, assets) }))
    .sort((a, b) => b.l.tradableBps - a.l.tradableBps || b.l.live - a.l.live || a.i - b.i)
    .map((x) => x.t);
}
