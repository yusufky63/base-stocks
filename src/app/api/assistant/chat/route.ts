import { route, json, parseBody } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";
import { requestCountry } from "@/lib/geo";
import { getAssets } from "@/services/b20-asset-service";
import { buildUniverseContext, cleanText, sanitizePrompt } from "@/services/basket-intent-service";
import { addSpend, checkQuota, clientIp, consumeQuota, monthlyBudgetUsd, monthlySpendUsd, quotaLimitsFromEnv } from "@/lib/ai-quota";
import { aiConfigFromEnv } from "@/lib/ai-provider";
import { runAssistantTurn } from "@/lib/assistant/loop";
import { assistantSystemPrompt } from "@/lib/assistant/prompt";
import { ALL_TOOLS, makeToolCtx, pathContext } from "@/lib/assistant/tools";
import { chatBodySchema } from "@/lib/assistant/schema";
import type { NormMessage } from "@/lib/assistant/model";

/** The tool loop may take several model rounds; the 10 s default is not enough. */
export const maxDuration = 60;

const MAX_USER_CHARS = 1_000;
const MAX_ASSISTANT_CHARS = 1_500;
const MAX_HISTORY_CHARS = 6_000;

/**
 * The assistant chat (Copilot): answers from live tool data, drafts actions the user signs in
 * their wallet. Hardened the same way as /api/portfolio/intent — fixed system prompt, symbols
 * only, per-IP/per-wallet/global quotas, monthly budget — with one quota unit per user turn
 * regardless of how many tool rounds it takes (the round cap bounds the cost).
 */
export const POST = route({ rateLimit: { key: "assistant.chat", limit: 10, windowMs: 60_000 } }, async (req) => {
  const cfg = aiConfigFromEnv();
  if (!cfg) throw new AppError("PROVIDER_UNAVAILABLE", "AI assistance is not enabled on this deployment.", 503);
  const body = await parseBody(req, chatBodySchema);
  const owner = body.owner ? ((body.owner.toLowerCase() as typeof body.owner)) : undefined;
  if (body.messages[body.messages.length - 1]!.role !== "user") throw new AppError("BAD_REQUEST", "The last message must be from the user.", 400);

  // History hygiene: cleaned, per-message caps, and a total budget that drops the oldest first.
  const cleaned = body.messages.map((m) => ({ role: m.role, content: m.role === "user" ? sanitizePrompt(m.content, MAX_USER_CHARS) : cleanText(m.content, MAX_ASSISTANT_CHARS) })).filter((m) => m.content.length > 0);
  if (cleaned.length === 0 || cleaned[cleaned.length - 1]!.role !== "user") throw new AppError("BAD_REQUEST", "Say something for the assistant to answer.", 400);
  let total = 0;
  const bounded: typeof cleaned = [];
  for (let i = cleaned.length - 1; i >= 0; i--) {
    total += cleaned[i]!.content.length;
    if (total > MAX_HISTORY_CHARS && bounded.length > 0) break;
    bounded.unshift(cleaned[i]!);
  }

  const limits = quotaLimitsFromEnv();
  const ip = clientIp(req);
  const [quota, spent] = await Promise.all([checkQuota(ip, owner, limits), monthlySpendUsd()]);
  const budget = monthlyBudgetUsd();
  if (budget > 0 && spent >= budget) {
    metrics.count("ai.budget", false, `monthly budget reached: $${spent.toFixed(2)} / $${budget}`);
    return json({ ok: false, errors: ["The assistant reached this month's budget. Everything still works manually."], quota: { remainingForWallet: 0, remainingForIp: 0 } }, { status: 429 });
  }
  if (!quota.allowed) {
    const msg =
      quota.reason === "burst"
        ? "Too many messages in a minute. Please wait a moment."
        : quota.reason === "global"
          ? "The assistant reached today's shared limit. Try again tomorrow."
          : "You reached today's assistant limit for this wallet.";
    return json({ ok: false, errors: [msg], quota: { remainingForWallet: quota.remainingForWallet, remainingForIp: quota.remainingForIp } }, { status: 429 });
  }

  const assets = (await getAssets()).filter((a) => a.status === "active");
  const universe = await buildUniverseContext(assets);
  const ctx = makeToolCtx(owner, assets, requestCountry(req));
  const system = assistantSystemPrompt(universe, { walletConnected: !!owner, pathNote: pathContext(body.path, assets) });

  await consumeQuota(ip, owner);
  const history: NormMessage[] = bounded.map((m) => ({ role: m.role, content: m.content }));

  try {
    const result = await runAssistantTurn(cfg, { system, history, tools: ALL_TOOLS.map((t) => ({ name: t.name, description: t.description, schema: t.schema })), ctx });
    void addSpend(result.costUsd);
    metrics.count("ai.cost", true, `${cfg.model} $${result.costUsd.toFixed(5)} (${result.usage.inputTokens} in / ${result.usage.outputTokens} out, chat)`);
    return json({
      ok: true,
      // Some models ignore the plain-text rule; markdown emphasis and headings are stripped here,
      // line breaks survive (cleanText would flatten them and lists become soup).
      reply: result.reply
        .replace(/<[^>]*>/g, " ")
        .replace(/[`*#_]{1,3}/g, "")
        .split("\n")
        .map((l) => l.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n")
        .slice(0, 2_000),
      actions: result.actions,
      quota: { remainingForWallet: Math.max(0, quota.remainingForWallet - 1), remainingForIp: Math.max(0, quota.remainingForIp - 1) },
    });
  } catch (err) {
    // The unit was consumed and the model may have been called; still record spend of zero-cost failures is moot.
    if (err instanceof AppError) throw err;
    metrics.count("assistant.turn", false, err instanceof Error ? err.message.slice(0, 160) : String(err));
    throw new AppError("PROVIDER_UNAVAILABLE", "The assistant could not answer right now. Please try again.", 502);
  }
});
