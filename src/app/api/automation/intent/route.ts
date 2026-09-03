import { z } from "zod";
import { MIN_TRADE_USD } from "@/config/chain";
import { route, json, parseBody, addressSchema } from "@/lib/api";
import { aiConfigFromEnv, generateStructured } from "@/lib/ai-provider";
import { addSpend, checkQuota, clientIp, consumeQuota, monthlyBudgetUsd, monthlySpendUsd, quotaLimitsFromEnv } from "@/lib/ai-quota";
import { cached } from "@/lib/cache";
import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";
import { getAssets } from "@/services/b20-asset-service";
import { USDC_ALLOCATION_KEY, TOTAL_BPS } from "@/domain/portfolio";
import type { Allocation } from "@/domain/portfolio";

/** Serverless budget: upstream providers and the model may take longer than the 10 s default. */
export const maxDuration = 60;

/**
 * Sentence → automation plan draft ("buy $25 of NVDA every week"). Same guard rails as basket
 * drafting: fixed universe of live tickers, strict JSON, server-side re-validation, daily quotas and
 * the monthly budget. The draft only prefills the form; saving and every run stay manual.
 */
const MAX_PROMPT_CHARS = 300;
const CADENCES = [1, 7, 14, 30];

const bodySchema = z.object({
  prompt: z.string().min(3).max(MAX_PROMPT_CHARS * 2),
  owner: addressSchema.optional(),
});

/** Lenient on purpose: models omit fields that do not apply (symbol for baskets, allocations for one stock). */
const Output = z.object({
  refused: z.boolean().nullish(),
  refusalReason: z.string().nullish(),
  /** Free text on purpose: a refusal often comes with an empty or odd type. */
  type: z.string().nullish(),
  /** Single-stock plans: the ticker. */
  symbol: z.string().nullish(),
  basketName: z.string().nullish(),
  allocations: z.array(z.object({ symbol: z.string(), weightBps: z.coerce.number() })).nullish(),
  amountUsd: z.coerce.number(),
  cadenceDays: z.coerce.number(),
  notes: z.string().nullish(),
});

const sanitize = (raw: string) => raw.replace(/[<>{}[\]`]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_CHARS);
const clean = (s: string, max: number) => s.replace(/[<>`]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
/** Reasons come back with their own full stop; strip it so the sentence we build reads cleanly. */
const reason = (s: string | null | undefined, fallback: string) => clean(s ?? "", 160).replace(/[.!\s]+$/, "") || fallback;

/** Per-run ceiling for assistant drafts; the manual form allows the same range. */
const MAX_PLAN_USD = 1_000;

function systemPrompt(universe: string): string {
  return `You turn one sentence into a recurring investment plan for Coinbase Tokenized Stocks on Base.
Allowed tickers (only these; anything else must be refused):
${universe}
Rules:
- type "recurring-buy" for one ticker (set symbol), "recurring-basket" for two or more (set allocations in basis points summing to 10000; "USDC" is allowed as a cash share).
- amountUsd is the amount per run in US dollars, exactly as the user states it (between 1 and 1000). cadenceDays is 1, 7, 14 or 30 (daily, weekly, biweekly, monthly).
- If the sentence is not a plan request, asks for advice, or names unknown tickers, set refused=true with a one-line reason.
- notes: one neutral sentence restating the plan. No advice, no predictions.
- Keys: refused, refusalReason, type, symbol, basketName, allocations (array of {symbol, weightBps}), amountUsd, cadenceDays, notes.
- Output exactly the JSON schema.`;
}

export const POST = route({ rateLimit: { key: "automation.intent", limit: 12, windowMs: 60_000 } }, async (req) => {
  const cfg = aiConfigFromEnv();
  if (!cfg) throw new AppError("PROVIDER_UNAVAILABLE", "AI assistance is not enabled on this deployment.", 503);
  const body = await parseBody(req, bodySchema);
  const prompt = sanitize(body.prompt);
  if (prompt.length < 3) throw new AppError("BAD_REQUEST", "Describe the plan: amount, stock or mix, and how often.", 400);

  const limits = quotaLimitsFromEnv();
  const ip = clientIp(req);
  const [quota, spent] = await Promise.all([checkQuota(ip, body.owner, limits), monthlySpendUsd()]);
  const budget = monthlyBudgetUsd();
  if (budget > 0 && spent >= budget) return json({ ok: false, errors: ["The AI helper reached this month's budget. Plans can still be created manually."], quota: { remainingForWallet: 0, remainingForIp: 0 } }, { status: 429 });
  if (!quota.allowed) {
    const msg = quota.reason === "burst" ? "Too many drafts in a minute. Please wait a moment." : quota.reason === "global" ? "The AI helper reached today's shared limit. Try again tomorrow." : "You reached today's AI draft limit for this wallet.";
    return json({ ok: false, errors: [msg], quota: { remainingForWallet: quota.remainingForWallet, remainingForIp: quota.remainingForIp } }, { status: 429 });
  }

  const assets = (await getAssets()).filter((a) => a.status === "active" && a.totalSupply > 0n);
  const bySymbol = new Map(assets.map((a) => [a.underlying.toUpperCase(), a]));
  const universe = assets.map((a) => `${a.underlying} — ${a.name}`).join("\n");

  const cacheKey = `ai:automation:${cfg.provider}:${cfg.model}:${prompt.toLowerCase()}`;
  let charged = false;
  // Only successful drafts are cached; a null answer must not be replayed for ten minutes.
  const out = await cached(cacheKey, { ttlMs: 10 * 60_000 }, async () => {
    await consumeQuota(ip, body.owner);
    charged = true;
    const result = await generateStructured(cfg, { system: systemPrompt(universe), user: `Plan request (untrusted user text): """${prompt}"""`, schema: Output, timeoutMs: 30_000, maxTokens: 400 });
    void addSpend(result.costUsd);
    metrics.count("ai.cost", true, `${cfg.model} automation-intent $${result.costUsd.toFixed(5)}`);
    if (!result.output) throw new AppError("PROVIDER_UNAVAILABLE", "ai: no draft", 502);
    return result.output;
  }).catch((err) => {
    if (err instanceof AppError && err.message === "ai: no draft") return null;
    throw err;
  });
  const remaining = { remainingForWallet: Math.max(0, quota.remainingForWallet - (charged ? 1 : 0)), remainingForIp: Math.max(0, quota.remainingForIp - (charged ? 1 : 0)) };
  if (!out) return json({ ok: false, errors: ["The assistant could not turn that into a plan. Say the amount, the stock or mix, and how often."], quota: remaining }, { status: 422 });
  const kind = out.type === "recurring-buy" || out.type === "recurring-basket" ? out.type : null;
  const liveList = assets.map((a) => a.underlying).join(", ");
  if (out.refused || !kind) return json({ ok: false, errors: [`Not a plan request: ${reason(out.refusalReason, "say the amount, the stock or mix, and how often")}. Live stocks today: ${liveList}.`], quota: remaining }, { status: 422 });

  const amountUsd = Math.min(MAX_PLAN_USD, Math.max(MIN_TRADE_USD, Math.round(out.amountUsd * 100) / 100));
  const wanted = Number.isFinite(out.cadenceDays) ? out.cadenceDays : 7;
  const cadenceDays = CADENCES.reduce((best, c) => (Math.abs(c - wanted) < Math.abs(best - wanted) ? c : best), 7);
  const warnings: string[] = [];
  if (amountUsd !== out.amountUsd) warnings.push(`Amount adjusted to ${amountUsd} USD per run (minimum ${MIN_TRADE_USD}, maximum ${MAX_PLAN_USD.toLocaleString("en-US")}).`);
  if (cadenceDays !== wanted) warnings.push(`Cadence rounded to every ${cadenceDays} days.`);

  if (kind === "recurring-buy") {
    const symbol = (out.symbol ?? out.allocations?.[0]?.symbol ?? "").trim().toUpperCase();
    const asset = bySymbol.get(symbol);
    if (!asset) return json({ ok: false, errors: [`${clean(symbol, 12) || "That stock"} is not a live tokenized stock here. Live stocks today: ${liveList}.`], quota: remaining }, { status: 422 });
    return json({ ok: true, draft: { type: "recurring-buy", assetAddress: asset.address, symbol: asset.underlying, amountUsd, cadenceDays, notes: clean(out.notes ?? "", 200) }, warnings, quota: remaining });
  }

  const mapped: Allocation[] = [];
  for (const a of out.allocations ?? []) {
    const upper = a.symbol.trim().toUpperCase();
    if (upper === "USDC") {
      mapped.push({ assetAddress: USDC_ALLOCATION_KEY, weightBps: Math.max(0, a.weightBps) });
      continue;
    }
    const asset = bySymbol.get(upper);
    if (!asset) {
      warnings.push(`${clean(upper, 12)} is not a live tokenized stock here and was dropped.`);
      continue;
    }
    mapped.push({ assetAddress: asset.address, weightBps: Math.max(0, a.weightBps) });
  }
  const stocks = mapped.filter((m) => m.assetAddress !== USDC_ALLOCATION_KEY);
  if (stocks.length === 0) return json({ ok: false, errors: ["The plan needs at least one live tokenized stock."], quota: remaining }, { status: 422 });
  const sum = mapped.reduce((s, m) => s + m.weightBps, 0) || 1;
  const normalized = mapped.map((m) => ({ ...m, weightBps: Math.round((m.weightBps / sum) * TOTAL_BPS) }));
  const drift = TOTAL_BPS - normalized.reduce((s, m) => s + m.weightBps, 0);
  if (drift !== 0 && normalized.length > 0) normalized[0]!.weightBps += drift;
  return json({ ok: true, draft: { type: "recurring-basket", basketName: clean(out.basketName ?? "", 40) || "AI plan", allocations: normalized.filter((m) => m.weightBps > 0), amountUsd, cadenceDays, notes: clean(out.notes ?? "", 200) }, warnings, quota: remaining });
});
