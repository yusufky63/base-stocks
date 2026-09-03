import { cached, invalidate } from "@/lib/cache";
import { formatUnits, parseUnits, type Address } from "viem";
import { MIN_TRADE_USD, USDC_DECIMALS } from "@/config/chain";
import type { B20Asset } from "@/domain/asset";
import { TOTAL_BPS, USDC_ALLOCATION_KEY, type Allocation, type PortfolioHolding, type PortfolioIntent, type PortfolioPlan, type PortfolioPlanLeg, type PortfolioSnapshot, type RebalanceSuggestion } from "@/domain/portfolio";
import { isCuratedAsset, findCuratedAsset, allAssetEntries } from "@/lib/b20/registry";
import { rawValueUsd, splitByWeights } from "@/lib/b20/math";
import { AppError } from "@/lib/errors";
import { getAssets, getBalances, getUsdcBalance } from "./b20-asset-service";
import { getRepos } from "@/db/repositories";
import { getPriceViews } from "./price-service";
import { tradeRouter } from "./trade-router";
import type { PortfolioEarnPosition, DeferredPolicy, PortfolioPlanDeferred, PortfolioLpPosition } from "@/domain/portfolio";
import { getEarnPositions } from "./earn-opportunity-service";
import { getLpPositions } from "./lp-positions-service";
import { metrics } from "@/lib/http";

/* ------------------------------ Allocation validation ------------------------------ */

export interface AllocationValidation {
  ok: boolean;
  errors: string[];
  normalized: Allocation[];
}

function symbolFor(key: string): string {
  const entry = allAssetEntries().find((e) => e.address.toLowerCase() === key);
  return entry?.underlying ?? `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** Shared client+server validation: sums to 10,000 bps, unique canonical assets, positive weights. */
export function validateAllocations(input: Allocation[], opts?: { allowedAssets?: Set<string> }): AllocationValidation {
  const errors: string[] = [];
  const seen = new Set<string>();
  const normalized: Allocation[] = [];
  for (const a of input) {
    const key = a.assetAddress === USDC_ALLOCATION_KEY ? USDC_ALLOCATION_KEY : a.assetAddress.toLowerCase();
    if (!Number.isInteger(a.weightBps) || a.weightBps <= 0 || a.weightBps > TOTAL_BPS) {
      const label = key === USDC_ALLOCATION_KEY ? "USDC" : symbolFor(key);
      errors.push(a.weightBps <= 0 ? `${label} has no weight yet: give it a share above 0% or remove it.` : `${label} needs a weight between 0.01% and 100%.`);
      continue;
    }
    if (seen.has(key)) {
      errors.push(`Duplicate allocation for ${key}.`);
      continue;
    }
    seen.add(key);
    if (key !== USDC_ALLOCATION_KEY) {
      if (!isCuratedAsset(key)) {
        errors.push(`${key} is not a verified Coinbase Tokenized Stock.`);
        continue;
      }
      if (opts?.allowedAssets && !opts.allowedAssets.has(key)) {
        errors.push(`${key} is not available for trading.`);
        continue;
      }
    }
    normalized.push({ assetAddress: key === USDC_ALLOCATION_KEY ? USDC_ALLOCATION_KEY : (a.assetAddress as Address), weightBps: a.weightBps });
  }
  const sum = normalized.reduce((s, a) => s + a.weightBps, 0);
  if (sum !== TOTAL_BPS) errors.push(`Allocations must total 100% (currently ${(sum / 100).toFixed(1)}%).`);
  if (normalized.filter((a) => a.assetAddress !== USDC_ALLOCATION_KEY).length === 0) errors.push("Add at least one stock.");
  return { ok: errors.length === 0, errors, normalized };
}

/* ------------------------------ Snapshot ------------------------------ */

/** Earn positions are part of the portfolio; a slow or failing venue never blocks the snapshot. */
async function earnPositionsSafe(owner: Address): Promise<PortfolioEarnPosition[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const positions = await Promise.race([
      getEarnPositions(owner),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("earn positions timeout")), 8_000);
      }),
    ]);
    return positions.map((p) => ({ opportunityId: p.opportunityId, provider: p.provider, title: p.title, valueUsd: p.valueUsd, variableApy: p.variableApy }));
  } catch (err) {
    metrics.count("portfolio.earn", false, err instanceof Error ? err.message : String(err));
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** LP positions holding a stock are part of the portfolio too; same timeout rule as Earn. */
async function lpPositionsSafe(owner: Address, assets: B20Asset[]): Promise<PortfolioLpPosition[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const positions = await Promise.race([
      getLpPositions(owner),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("lp positions timeout")), 8_000);
      }),
    ]);
    const isStock = (addr: string) => assets.some((a) => a.canonicalId === addr.toLowerCase());
    return positions.map((p) => {
      const stockIs0 = isStock(p.token0.address);
      const stock = stockIs0 ? p.token0 : isStock(p.token1.address) ? p.token1 : null;
      const quote = stock === p.token0 ? p.token1 : p.token0;
      return {
        manager: p.manager,
        managerLabel: p.managerLabel,
        provider: p.provider,
        tokenId: p.tokenId,
        pair: `${p.token0.symbol}/${p.token1.symbol}`,
        stockAddress: stock?.address ?? null,
        stockSymbol: stock?.symbol ?? null,
        stockAmount: stock ? (stock === p.token0 ? p.amount0 : p.amount1) : 0,
        quoteSymbol: quote.symbol,
        quoteAmount: quote === p.token0 ? p.amount0 : p.amount1,
        valueUsd: p.valueUsd,
        feesUsd: p.fees.usd,
        inRange: p.inRange,
        manageUrl: p.manageUrl,
      };
    });
  } catch (err) {
    metrics.count("portfolio.lp", false, err instanceof Error ? err.message : String(err));
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Drop the cached snapshot after an action that changes balances (trade record, earn action). */
export function invalidatePortfolioSnapshot(owner: Address): void {
  invalidate(`portfolio:snapshot:${owner.toLowerCase()}`);
}

/** Snapshot shared for 15 s per wallet: several tabs and the 45 s poll cost one set of reads, not many. */
export async function getPortfolioSnapshot(owner: Address): Promise<PortfolioSnapshot> {
  return cached(`portfolio:snapshot:${owner.toLowerCase()}`, { ttlMs: 15_000, staleMs: 45_000 }, () => computePortfolioSnapshot(owner));
}

async function computePortfolioSnapshot(owner: Address): Promise<PortfolioSnapshot> {
  const assets = await getAssets();
  const [balances, usdc, views, earnPositions, lpPositions] = await Promise.all([getBalances(owner, assets), getUsdcBalance(owner), getPriceViews(assets), earnPositionsSafe(owner), lpPositionsSafe(owner, assets)]);
  const usdcValueUsd = Number(formatUnits(usdc, USDC_DECIMALS));
  const earnValueUsd = earnPositions.reduce((s, p) => s + p.valueUsd, 0);
  const lpValueUsd = lpPositions.reduce((s, p) => s + (p.valueUsd ?? 0), 0);

  const holdings: PortfolioHolding[] = [];
  for (const a of assets) {
    const b = balances.find((x) => x.assetAddress.toLowerCase() === a.canonicalId);
    if (!b || b.rawBalance === 0n) continue;
    const v = views.get(a.canonicalId);
    const price = v?.displayUsd ?? null;
    const marketValueUsd = price !== null ? rawValueUsd(b.rawBalance, a.decimals, price) : 0;
    const referenceValueUsd = v?.referenceUsd !== null && v?.referenceUsd !== undefined ? rawValueUsd(b.rawBalance, a.decimals, v.referenceUsd) : null;
    holdings.push({
      assetAddress: a.address,
      symbol: a.symbol,
      name: a.name,
      underlying: a.underlying,
      logoURI: a.logoURI,
      rawBalance: b.rawBalance.toString(),
      scaledBalance: b.scaledBalance.toString(),
      decimals: a.decimals,
      multiplier: a.multiplier.toString(),
      marketValueUsd,
      referenceValueUsd,
      priceUsd: price,
      priceSource: v?.displaySource ?? "none",
      change24hPct: v?.marketChange24hPct ?? null,
      currentWeightBps: 0,
    });
  }
  const total = holdings.reduce((s, h) => s + h.marketValueUsd, 0) + usdcValueUsd + earnValueUsd + lpValueUsd;
  for (const h of holdings) h.currentWeightBps = total > 0 ? Math.round((h.marketValueUsd / total) * TOTAL_BPS) : 0;
  holdings.sort((x, y) => y.marketValueUsd - x.marketValueUsd);

  let weighted = 0;
  let weightBase = 0;
  for (const h of holdings) {
    if (h.change24hPct !== null && h.marketValueUsd > 0) {
      weighted += h.change24hPct * h.marketValueUsd;
      weightBase += h.marketValueUsd;
    }
  }
  const snapshot: PortfolioSnapshot = {
    owner,
    totalValueUsd: total,
    usdcBalance: usdc.toString(),
    usdcValueUsd,
    earnValueUsd,
    earnPositions,
    lpValueUsd,
    lpPositions,
    holdings,
    change24hPct: weightBase > 0 ? weighted / weightBase : null,
    readAt: Date.now(),
  };
  void recordDailySnapshot(snapshot);
  return snapshot;
}

const snapshotWritten = new Map<string, string>();

/** Value history for the portfolio chart: one row per wallet per UTC day, upserted on load. */
async function recordDailySnapshot(s: PortfolioSnapshot): Promise<void> {
  if (s.totalValueUsd <= 0) return;
  const day = new Date().toISOString().slice(0, 10);
  const key = s.owner.toLowerCase();
  if (snapshotWritten.get(key) === day) return;
  snapshotWritten.set(key, day);
  try {
    await getRepos().snapshots.record({
      address: s.owner,
      day,
      totalUsd: Math.round(s.totalValueUsd * 100) / 100,
      holdings: s.holdings.map((h) => ({ assetAddress: h.assetAddress, symbol: h.underlying, valueUsd: Math.round(h.marketValueUsd * 100) / 100, weightBps: h.currentWeightBps })),
      createdAt: Date.now(),
    });
  } catch {
    snapshotWritten.delete(key);
  }
}

/* ------------------------------ Plan ------------------------------ */

export function buildPlan(intent: PortfolioIntent, totalUsd: number, assets: B20Asset[], opts: { deferredPolicy?: DeferredPolicy } = {}): PortfolioPlan {
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) throw new AppError("BAD_REQUEST", "Enter an amount to invest.", 400);
  const v = validateAllocations(intent.allocations, { allowedAssets: new Set(assets.filter((a) => a.status === "active").map((a) => a.canonicalId)) });
  if (!v.ok) throw new AppError("BAD_REQUEST", v.errors.join(" "), 400, { errors: v.errors });
  const policy: DeferredPolicy = opts.deferredPolicy ?? "reserve";
  const byId = new Map(assets.map((a) => [a.canonicalId, a]));
  const assetOf = (key: string) => byId.get(key.toLowerCase())!;
  // "Deployed != issued": a stock whose token has no supply cannot be bought anywhere yet.
  const isDeferred = (key: string) => assetOf(key).totalSupply === 0n;

  const usdcAlloc = v.normalized.find((a) => a.assetAddress === USDC_ALLOCATION_KEY);
  const keepUsdcBps = usdcAlloc?.weightBps ?? 0;
  const stocks = v.normalized.filter((a) => a.assetAddress !== USDC_ALLOCATION_KEY);
  const deferredAllocs = stocks.filter((a) => isDeferred(a.assetAddress as string));
  const liveAllocs = stocks.filter((a) => !isDeferred(a.assetAddress as string));
  const deferredBps = deferredAllocs.reduce((sum, a) => sum + a.weightBps, 0);
  // reserve: the deferred names' money stays in USDC; redistribute: their weight is spread over live names.
  const keepBps = policy === "reserve" ? keepUsdcBps + deferredBps : keepUsdcBps;

  const totalCents = BigInt(Math.round(totalUsd * 100));
  const keepCents = (totalCents * BigInt(keepBps)) / BigInt(TOTAL_BPS);
  const investCents = totalCents - keepCents;
  const parts = liveAllocs.length > 0 ? splitByWeights(investCents, liveAllocs.map((a) => a.weightBps)) : [];

  const warnings: string[] = [];
  const legs: PortfolioPlanLeg[] = liveAllocs.map((a, i) => {
    const asset = assetOf(a.assetAddress as string);
    const usd = Number(parts[i]!) / 100;
    if (usd < MIN_TRADE_USD) warnings.push(`${asset.symbol}: $${usd.toFixed(2)} is below the $${MIN_TRADE_USD} minimum and will be skipped.`);
    return {
      assetAddress: asset.address,
      symbol: asset.symbol,
      weightBps: totalCents > 0n ? Number((parts[i]! * BigInt(TOTAL_BPS)) / totalCents) : a.weightBps,
      targetUsd: usd,
      sellAmountUsdc: parseUnits(usd.toFixed(USDC_DECIMALS), USDC_DECIMALS).toString(),
    };
  });
  const deferred: PortfolioPlanDeferred[] = deferredAllocs.map((a) => {
    const asset = assetOf(a.assetAddress as string);
    return { assetAddress: asset.address, symbol: asset.symbol, weightBps: a.weightBps, targetUsd: Number((totalCents * BigInt(a.weightBps)) / BigInt(TOTAL_BPS)) / 100, reason: "not issued on Base yet" };
  });
  if (deferred.length > 0) {
    const names = deferred.map((d) => d.symbol.replace(/c$/, "")).join(", ");
    const usd = deferred.reduce((sum, d) => sum + d.targetUsd, 0);
    warnings.push(
      policy === "reserve"
        ? `${names}: not issued on Base yet, so $${usd.toFixed(2)} stays in USDC until Coinbase mints ${deferred.length === 1 ? "it" : "them"}. Buy later from the stock page.`
        : `${names}: not issued on Base yet; their ${(deferredBps / 100).toFixed(1)}% was spread across the live stocks.`,
    );
  }
  for (const a of assets) {
    if (legs.some((l) => l.assetAddress.toLowerCase() === a.canonicalId) && a.oracle?.paused) warnings.push(`${a.symbol}: corporate action in progress, reference price frozen.`);
  }
  return { totalUsd, keepUsdcUsd: Number(keepCents) / 100, keepUsdcBps: keepBps, legs: legs.filter((l) => l.targetUsd >= MIN_TRADE_USD), deferred, deferredPolicy: policy, minTradeUsd: MIN_TRADE_USD, warnings };
}

/** Attach executable indicative quotes to every leg (parallel, never throws for a single leg). */
export async function quotePlan(plan: PortfolioPlan, taker?: Address): Promise<PortfolioPlan> {
  const legs = await Promise.all(
    plan.legs.map(async (leg): Promise<PortfolioPlanLeg> => {
      try {
        const q = await tradeRouter.price({ side: "buy", assetAddress: leg.assetAddress, sellAmount: BigInt(leg.sellAmountUsdc), taker });
        return { ...leg, estimatedBuyAmount: q.buyAmount, estimatedPriceUsd: q.executablePriceUsd, provider: q.provider };
      } catch (err) {
        return { ...leg, quoteError: err instanceof AppError ? err.message : "Quote unavailable" };
      }
    }),
  );
  return { ...plan, legs };
}

/* ------------------------------ Rebalance ------------------------------ */

export function rebalanceSuggestions(snapshot: PortfolioSnapshot, target: Allocation[], symbolFor?: (address: string) => string | undefined): RebalanceSuggestion[] {
  const total = snapshot.totalValueUsd;
  if (total <= 0) return [];
  const out: RebalanceSuggestion[] = [];
  const targetMap = new Map(target.map((t) => [t.assetAddress === USDC_ALLOCATION_KEY ? USDC_ALLOCATION_KEY : t.assetAddress.toLowerCase(), t.weightBps]));
  const keys = new Set<string>([...targetMap.keys(), ...snapshot.holdings.map((h) => h.assetAddress.toLowerCase()), USDC_ALLOCATION_KEY]);
  for (const key of keys) {
    const targetBps = targetMap.get(key) ?? 0;
    const holding = key === USDC_ALLOCATION_KEY ? null : snapshot.holdings.find((h) => h.assetAddress.toLowerCase() === key);
    const currentUsd = key === USDC_ALLOCATION_KEY ? snapshot.usdcValueUsd : (holding?.marketValueUsd ?? 0);
    const currentBps = Math.round((currentUsd / total) * TOTAL_BPS);
    const deltaUsd = (targetBps / TOTAL_BPS) * total - currentUsd;
    const action: RebalanceSuggestion["action"] = Math.abs(deltaUsd) < Math.max(MIN_TRADE_USD, total * 0.005) ? "hold" : deltaUsd > 0 ? "buy" : "sell";
    const resolved = key === USDC_ALLOCATION_KEY ? "USDC" : (holding?.symbol ?? symbolFor?.(key) ?? findCuratedAsset(key)?.underlying ?? `${key.slice(0, 6)}…${key.slice(-4)}`);
    out.push({
      assetAddress: key === USDC_ALLOCATION_KEY ? USDC_ALLOCATION_KEY : ((holding?.assetAddress ?? findCuratedAsset(key)?.address ?? key) as Address),
      symbol: resolved,
      currentWeightBps: currentBps,
      targetWeightBps: targetBps,
      deltaUsd,
      action,
    });
  }
  return out.sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd));
}
