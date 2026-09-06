import { getPriceViews } from "@/services/price-service";
import { validateAllocations } from "@/services/portfolio-service";
import { hasMeaningfulChange, referenceGapNote, tradingStatus } from "@/lib/trading-status";
import { TOTAL_BPS, USDC_ALLOCATION_KEY, type Allocation } from "@/domain/portfolio";
import type { B20Asset } from "@/domain/asset";
import type { DraftCommentary } from "@/lib/client-api";

/**
 * The shared core of AI basket drafting: universe context for prompts, symbol resolution and
 * draft finalization. Extracted from /api/portfolio/intent so the assistant chat's draft_basket
 * tool and the intent route validate drafts through the exact same code.
 */

export function sanitizePrompt(raw: string, maxChars = 400): string {
  return raw
    .replace(/[ -]/g, " ")
    .replace(/[<>{}[\]`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

export function cleanText(s: string, max: number): string {
  return s.replace(/<[^>]*>/g, " ").replace(/[<>`]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function normalizeToTotal(allocs: Allocation[]): Allocation[] {
  const sum = allocs.reduce((s, a) => s + a.weightBps, 0);
  if (sum === TOTAL_BPS || sum <= 0) return allocs;
  const scaled = allocs.map((a) => ({ ...a, weightBps: Math.max(1, Math.round((a.weightBps / sum) * TOTAL_BPS)) }));
  const diff = TOTAL_BPS - scaled.reduce((s, a) => s + a.weightBps, 0);
  if (diff !== 0) {
    const idx = scaled.reduce((best, a, i) => (a.weightBps > scaled[best]!.weightBps ? i : best), 0);
    scaled[idx]!.weightBps += diff;
  }
  return scaled;
}

/** Exact ticker first (INTC, COIN end with C); only then treat a trailing "c" as the B20 suffix (NVDAc → NVDA). */
export function resolveSymbol(bySymbol: Map<string, B20Asset>, raw: string): B20Asset | undefined {
  const upper = raw.trim().toUpperCase();
  return bySymbol.get(bySymbol.has(upper) ? upper : upper.replace(/C$/, ""));
}

export function symbolMap(assets: B20Asset[]): Map<string, B20Asset> {
  return new Map(assets.map((a) => [a.underlying.toUpperCase(), a]));
}

/**
 * Market context so drafts and chat answers follow data, not vibes: the same status Markets
 * shows, price, 24h move, DEX liquidity, one line per stock.
 */
export async function buildUniverseContext(assets: B20Asset[]): Promise<string> {
  const views = await getPriceViews(assets).catch(() => new Map());
  return assets
    .map((a) => {
      const v = views.get(a.canonicalId);
      const status = tradingStatus({ status: a.status, totalSupply: a.totalSupply.toString() }, v ? { liquidityUsd: v.liquidityUsd, volume24hUsd: v.volume24hUsd } : null);
      const ctx =
        status.status === "not-issued"
          ? "not issued yet · no market"
          : `${status.label.toLowerCase()} · ${v?.displayUsd !== null && v?.displayUsd !== undefined ? `$${v.displayUsd.toFixed(2)}` : "price n/a"}${v && hasMeaningfulChange(status.status, v) ? ` · ${v.marketChange24hPct! >= 0 ? "+" : ""}${v.marketChange24hPct!.toFixed(1)}% 24h` : ""}${v?.liquidityUsd ? ` · liquidity $${Math.round(v.liquidityUsd / 1000)}k` : " · no pool"}${referenceGapNote(v) ? ` · ${referenceGapNote(v)}` : ""}`;
      return `${a.underlying} — ${a.name} [${a.tags.join(", ")}] · ${ctx}`;
    })
    .join("\n");
}

export interface RawBasketDraft {
  name: string;
  allocations: Array<{ symbol: string; weightBps: number }>;
  notes: string;
  commentary?: { thesis?: string | null; legs?: Array<{ symbol: string; why: string }> | null; risks?: string[] | null; fromNews?: string[] | null } | null;
}

export interface FinalizedBasketDraft {
  ok: boolean;
  warnings: string[];
  errors: string[];
  intent?: { name: string; allocations: Allocation[]; notes: string; source: "ai"; commentary: DraftCommentary };
}

/**
 * Map a model draft (symbols + weights) onto canonical assets, normalize weights to 10000 bps,
 * re-validate, and clean the commentary — the model's output is never trusted as-is.
 */
export function finalizeBasketDraft(assets: B20Asset[], out: RawBasketDraft): FinalizedBasketDraft {
  const bySymbol = symbolMap(assets);
  const warnings: string[] = [];
  const mapped: Allocation[] = [];
  for (const a of out.allocations) {
    const upper = a.symbol.trim().toUpperCase();
    if (upper === USDC_ALLOCATION_KEY || upper === "USD" || upper === "CASH") {
      mapped.push({ assetAddress: USDC_ALLOCATION_KEY, weightBps: a.weightBps });
      continue;
    }
    const asset = resolveSymbol(bySymbol, a.symbol);
    if (!asset) {
      warnings.push(`${cleanText(a.symbol, 12)} is not available and was dropped.`);
      continue;
    }
    mapped.push({ assetAddress: asset.address, weightBps: a.weightBps });
  }
  const normalized = normalizeToTotal(mapped.filter((a) => a.weightBps > 0));
  const v = validateAllocations(normalized, { allowedAssets: new Set(assets.map((a) => a.canonicalId)) });
  if (!v.ok) return { ok: false, warnings, errors: v.errors };

  const inBasket = new Set(v.normalized.filter((a) => a.assetAddress !== USDC_ALLOCATION_KEY).map((a) => (a.assetAddress as string).toLowerCase()));
  const c = out.commentary;
  const commentary: DraftCommentary = {
    thesis: cleanText(c?.thesis ?? "", 320),
    legs: (c?.legs ?? [])
      .map((l) => ({ asset: resolveSymbol(bySymbol, l.symbol), why: cleanText(l.why, 180) }))
      .filter((l): l is { asset: B20Asset; why: string } => !!l.asset && inBasket.has(l.asset.canonicalId) && !!l.why)
      .map((l) => ({ symbol: l.asset.underlying, why: l.why }))
      .slice(0, 10),
    risks: (c?.risks ?? []).map((r) => cleanText(r, 200)).filter(Boolean).slice(0, 4),
    fromNews: (c?.fromNews ?? []).map((n) => cleanText(n, 220)).filter(Boolean).slice(0, 4),
  };

  return {
    ok: true,
    warnings,
    errors: [],
    intent: {
      name: cleanText(out.name, 40).replace(/[^\w\s&.-]/g, "") || "AI draft",
      allocations: v.normalized,
      notes: cleanText(out.notes, 240),
      source: "ai",
      commentary,
    },
  };
}
