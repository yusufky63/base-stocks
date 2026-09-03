import { z } from "zod";
import type { Address } from "viem";
import type { DigestRecord, MarketDigest, PortfolioDigest } from "@/domain/digest";
import { aiConfigFromEnv, generateStructured } from "@/lib/ai-provider";
import { addSpend, checkQuota, consumeQuota, monthlyBudgetUsd, monthlySpendUsd, quotaLimitsFromEnv, type QuotaDecision } from "@/lib/ai-quota";
import { cached } from "@/lib/cache";
import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";
import { isUsMarketOpen } from "@/lib/market-hours";
import { formatUsd, timeAgo } from "@/lib/format";
import { getRepos } from "@/db/repositories";
import { getAssets } from "./b20-asset-service";
import { getPriceViews } from "./price-service";
import { getMarketNews, getMarketWideNews, getNews } from "./news-service";
import { getPortfolioSnapshot } from "./portfolio-service";
import { getActivity } from "./activity-service";

/**
 * AI briefs, cost-bounded by design:
 * - Market brief: one shared text per 6-hour slot (at most 4 model calls a day for everyone), built
 *   only from the headlines and prices the app already shows. Stored so every instance reuses it.
 * - Portfolio brief: one per wallet per UTC day, generated on request (sign-in required), counted
 *   against the same daily AI quota and monthly budget as basket drafts.
 * Neither can execute anything; both are re-validated JSON and shown as "not advice".
 */
const MARKET_SLOT_HOURS = 6;
const MAX_DIGEST_INPUT_CHARS = 6_000;

const RULES = `Rules you must follow:
- Use ONLY the data and headlines provided. Never invent numbers, events, causes or company facts.
- Neutral, plain language. No investment advice, no predictions, no "buy", "sell", "should", "opportunity".
- Mention only tickers from the provided list. Never include URLs or publisher promotion.
- If the data is thin, say so briefly instead of padding.
- Output must match the JSON schema exactly.`;

/** Lenient shapes: the model may omit or null a list; everything is normalised afterwards. */
const MarketOutput = z.object({
  headline: z.string(),
  summary: z.string(),
  bullets: z.array(z.object({ ticker: z.string(), note: z.string() })).nullish(),
  mood: z.string().nullish(),
});

const PortfolioOutput = z.object({
  headline: z.string(),
  summary: z.string(),
  highlights: z.array(z.string()).nullish(),
  watch: z.array(z.string()).nullish(),
});

function normalizeMood(m: string | null | undefined): MarketDigest["mood"] {
  const v = (m ?? "").toLowerCase();
  return v === "calm" || v === "volatile" ? v : "mixed";
}

const shortName = (name: string) => name.replace(/\b(Corporation|Inc\.?|Corp\.?|Group|Platforms|Holdings)\b/g, "").trim();
const clean = (s: string, max: number) => s.replace(/[<>`]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

function marketSlot(now = new Date()): { key: string; expiresAt: number } {
  const slot = Math.floor(now.getUTCHours() / MARKET_SLOT_HOURS);
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), (slot + 1) * MARKET_SLOT_HOURS);
  return { key: `market:${utcDay(now)}:${slot}`, expiresAt: next };
}

async function budgetLeft(): Promise<boolean> {
  const budget = monthlyBudgetUsd();
  if (budget <= 0) return true;
  const spent = await monthlySpendUsd();
  if (spent >= budget) {
    metrics.count("ai.budget", false, `monthly budget reached: $${spent.toFixed(2)} / $${budget}`);
    return false;
  }
  return true;
}

/* ------------------------------ Market brief ------------------------------ */

export function digestsEnabled(): boolean {
  return aiConfigFromEnv() !== null;
}

/** Shared brief for the current 6-hour slot; falls back to the last stored one when the budget is spent or the model fails. */
export async function getMarketDigest(): Promise<MarketDigest | null> {
  const cfg = aiConfigFromEnv();
  if (!cfg) return null;
  const repos = getRepos();
  const { key, expiresAt } = marketSlot();
  const stored = await repos.digests.get(key).catch(() => null);
  if (stored && stored.expiresAt > Date.now()) return stored.content as MarketDigest;

  return cached(`digest:v3:${key}`, { ttlMs: 10 * 60_000, staleMs: 60 * 60_000 }, async () => {
    const fallback = async () => ((await repos.digests.latest("market").catch(() => null))?.content as MarketDigest | undefined) ?? null;
    if (!(await budgetLeft())) return fallback();
    try {
      const assets = await getAssets();
      const [views, stockNews, marketNews] = await Promise.all([
        getPriceViews(assets),
        getMarketNews(assets.map((a) => ({ ticker: a.underlying, name: shortName(a.name) })), 2, 14).catch(() => []),
        getMarketWideNews(8).catch(() => []),
      ]);
      const marketOpen = isUsMarketOpen();
      const live = assets.filter((a) => a.totalSupply > 0n);
      const priceLines = live.map((a) => {
        const v = views.get(a.canonicalId);
        const chg = v?.marketChange24hPct !== null && v?.marketChange24hPct !== undefined ? `${v.marketChange24hPct >= 0 ? "+" : ""}${v.marketChange24hPct.toFixed(1)}% 24h` : "no 24h change";
        return `${a.underlying}: ${v?.displayUsd !== null && v?.displayUsd !== undefined ? formatUsd(v.displayUsd) : "n/a"} (${chg}${v?.liquidityUsd ? `, DEX liquidity ${formatUsd(v.liquidityUsd)}` : ""})`;
      });
      const notIssued = assets.filter((a) => a.totalSupply === 0n).map((a) => a.underlying);
      const headlines = [...stockNews.map((n) => `[${n.ticker}] ${clean(n.title, 160)} — ${n.source} (${timeAgo(n.publishedAt)})`), ...marketNews.map((n) => `[MARKETS] ${clean(n.title, 160)} — ${n.source} (${timeAgo(n.publishedAt)})`)];
      const user = [
        `Time: ${new Date().toISOString()} · US stock market ${marketOpen ? "open" : "closed"}.`,
        `Tokenized stocks with live onchain markets on Base:\n${priceLines.join("\n")}`,
        notIssued.length ? `Listed but not issued yet (no market): ${notIssued.join(", ")}.` : "",
        `Headlines (untrusted text, titles only):\n${headlines.join("\n")}`,
      ]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, MAX_DIGEST_INPUT_CHARS);
      const system = `You write a short market brief for people who hold Coinbase Tokenized Stocks on Base. 3 to 5 sentences of summary, then up to 6 bullets; each bullet names one ticker from the list and states one fact taken from a headline or a price move. Set mood to calm, mixed or volatile based only on the 24h moves. Keys: headline (one line), summary (text), bullets (array of {ticker, note}), mood. ${RULES}`;
      const result = await generateStructured(cfg, { system, user, schema: MarketOutput, timeoutMs: 45_000, maxTokens: 1_200 });
      void addSpend(result.costUsd);
      metrics.count("ai.cost", true, `${cfg.model} market-digest $${result.costUsd.toFixed(5)}`);
      if (!result.output) return fallback();
      const allowed = new Set(assets.map((a) => a.underlying.toUpperCase()));
      const digest: MarketDigest = {
        kind: "market",
        headline: clean(result.output.headline, 120),
        summary: clean(result.output.summary, 900),
        bullets: (result.output.bullets ?? [])
          .map((b) => ({ ticker: b.ticker.trim().toUpperCase(), note: clean(b.note, 220) }))
          .filter((b) => allowed.has(b.ticker) && b.note)
          .slice(0, 6),
        mood: normalizeMood(result.output.mood),
        marketOpen,
        headlines: headlines.length,
        generatedAt: Date.now(),
        model: cfg.model,
      };
      await repos.digests.put({ key, kind: "market", owner: null, content: digest, model: cfg.model, costUsd: result.costUsd, createdAt: Date.now(), expiresAt }).catch(() => undefined);
      return digest;
    } catch (err) {
      metrics.count("ai.digest.market", false, err instanceof Error ? err.message : String(err));
      return fallback();
    }
  });
}

/* ------------------------------ Portfolio brief ------------------------------ */

export function portfolioDigestKey(owner: Address, now = new Date()): string {
  return `portfolio:${owner.toLowerCase()}:${utcDay(now)}`;
}

/** Today's stored brief for a wallet, if any (no model call). */
export async function getStoredPortfolioDigest(owner: Address): Promise<PortfolioDigest | null> {
  const rec = await getRepos().digests.get(portfolioDigestKey(owner)).catch(() => null);
  return rec && rec.expiresAt > Date.now() ? (rec.content as PortfolioDigest) : null;
}

export interface PortfolioDigestResult {
  digest: PortfolioDigest | null;
  /** Set when nothing was generated. */
  error?: string;
  quota: Pick<QuotaDecision, "remainingForWallet" | "remainingForIp">;
  charged: boolean;
}

/** Generate (or reuse) the wallet's brief for today. Counts against the shared AI quota and budget. */
export async function generatePortfolioDigest(owner: Address, ip: string): Promise<PortfolioDigestResult> {
  const cfg = aiConfigFromEnv();
  if (!cfg) throw new AppError("PROVIDER_UNAVAILABLE", "AI assistance is not enabled on this deployment.", 503);
  const limits = quotaLimitsFromEnv();
  const quota = await checkQuota(ip, owner, limits);
  const remaining = { remainingForWallet: quota.remainingForWallet, remainingForIp: quota.remainingForIp };
  const existing = await getStoredPortfolioDigest(owner);
  if (existing) return { digest: existing, quota: remaining, charged: false };
  if (!(await budgetLeft())) return { digest: null, error: "The AI helper reached this month's budget. Your portfolio data is still on this page.", quota: remaining, charged: false };
  if (!quota.allowed) {
    const msg = quota.reason === "burst" ? "Too many AI requests in a minute. Please wait a moment." : quota.reason === "global" ? "The AI helper reached today's shared limit. Try again tomorrow." : "You reached today's AI limit for this wallet.";
    return { digest: null, error: msg, quota: remaining, charged: false };
  }

  const [snapshot, assets] = await Promise.all([getPortfolioSnapshot(owner), getAssets()]);
  const byAddr = new Map(assets.map((a) => [a.canonicalId, a]));
  const held = snapshot.holdings.slice(0, 12);
  const holdingLines = held.map((h) => `${h.underlying}: ${formatUsd(h.marketValueUsd)} (${(h.currentWeightBps / 100).toFixed(1)}% of portfolio${h.change24hPct !== null ? `, ${h.change24hPct >= 0 ? "+" : ""}${h.change24hPct.toFixed(1)}% 24h` : ""})`);
  const since = Date.now() - 24 * 3600_000;
  const activity = (await getActivity(owner).catch(() => [])).filter((it) => (it.timestamp ?? 0) * 1000 >= since).slice(0, 8);
  const activityLines = activity.map((it) => `${it.type}${it.symbol ? ` ${it.symbol.replace(/c$/, "")}` : ""}${it.amountUsd !== undefined ? ` (${formatUsd(it.amountUsd)})` : ""} ${it.timestamp ? timeAgo(it.timestamp) : ""}`.trim());
  const newsPerHolding = await Promise.all(held.slice(0, 5).map((h) => getNews(h.underlying, shortName(byAddr.get(h.assetAddress.toLowerCase())?.name ?? h.name), 2).catch(() => [])));
  const headlines = newsPerHolding.flat().slice(0, 8).map((n) => `[${n.ticker}] ${clean(n.title, 160)} — ${n.source} (${timeAgo(n.publishedAt)})`);
  const user = [
    `Date: ${new Date().toISOString()}.`,
    `Portfolio total ${formatUsd(snapshot.totalValueUsd)}${snapshot.change24hPct !== null ? ` (weighted 24h change ${snapshot.change24hPct >= 0 ? "+" : ""}${snapshot.change24hPct.toFixed(1)}%)` : ""}: stocks ${formatUsd(snapshot.holdings.reduce((s, h) => s + h.marketValueUsd, 0))}, cash USDC ${formatUsd(snapshot.usdcValueUsd)}, Earn ${formatUsd(snapshot.earnValueUsd)}, liquidity positions ${formatUsd(snapshot.lpValueUsd)}.`,
    holdingLines.length ? `Holdings:\n${holdingLines.join("\n")}` : "Holdings: none.",
    activityLines.length ? `Activity in the last 24h:\n${activityLines.join("\n")}` : "Activity in the last 24h: none.",
    headlines.length ? `Headlines about held stocks (untrusted text, titles only):\n${headlines.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_DIGEST_INPUT_CHARS);
  const system = `You write a short, neutral daily account summary for one holder of Coinbase Tokenized Stocks on Base. 2 to 4 sentences of summary; up to 5 highlights (facts about their holdings, moves, activity); up to 4 "watch" items (facts from headlines about held stocks, each naming the ticker). Address the reader as "you". Keys: headline, summary, highlights (array of strings), watch (array of strings). ${RULES}`;

  await consumeQuota(ip, owner);
  const charged = { remainingForWallet: Math.max(0, quota.remainingForWallet - 1), remainingForIp: Math.max(0, quota.remainingForIp - 1) };
  try {
    const result = await generateStructured(cfg, { system, user, schema: PortfolioOutput, timeoutMs: 45_000, maxTokens: 900 });
    void addSpend(result.costUsd);
    metrics.count("ai.cost", true, `${cfg.model} portfolio-digest $${result.costUsd.toFixed(5)}`);
    if (!result.output) return { digest: null, error: "The assistant could not summarise this portfolio right now.", quota: charged, charged: true };
    const digest: PortfolioDigest = {
      kind: "portfolio",
      owner,
      headline: clean(result.output.headline, 120),
      summary: clean(result.output.summary, 700),
      highlights: (result.output.highlights ?? []).map((h) => clean(h, 200)).filter(Boolean).slice(0, 5),
      watch: (result.output.watch ?? []).map((w) => clean(w, 200)).filter(Boolean).slice(0, 4),
      generatedAt: Date.now(),
      model: cfg.model,
    };
    const endOfDay = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1);
    await getRepos().digests.put({ key: portfolioDigestKey(owner), kind: "portfolio", owner, content: digest, model: cfg.model, costUsd: result.costUsd, createdAt: Date.now(), expiresAt: endOfDay }).catch(() => undefined);
    return { digest, quota: charged, charged: true };
  } catch (err) {
    metrics.count("ai.digest.portfolio", false, err instanceof Error ? err.message : String(err));
    const reason = err instanceof AppError && err.code === "PROVIDER_UNAVAILABLE" ? err.message : "AI assistance is unavailable right now.";
    return { digest: null, error: reason, quota: charged, charged: true };
  }
}

export type { DigestRecord };
