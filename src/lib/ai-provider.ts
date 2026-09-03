import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";

/**
 * One small abstraction over the model call so the app can run on Anthropic (default, structured
 * outputs enforced by the API) or on any OpenAI-compatible endpoint (DeepSeek, OpenRouter, a local
 * server) when cost or residency matters. Every provider returns the same validated object, and
 * every call reports token usage so the monthly budget guard can price it.
 */
export type AiProvider = "anthropic" | "openai";

export interface AiConfig {
  provider: AiProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxOutputTokens: number;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** USD per million tokens. Override per deployment with AI_PRICE_IN / AI_PRICE_OUT (USD per MTok). */
const PRICES: Array<{ match: RegExp; inUsd: number; outUsd: number; cacheReadUsd: number }> = [
  { match: /haiku/i, inUsd: 1, outUsd: 5, cacheReadUsd: 0.1 },
  { match: /sonnet/i, inUsd: 3, outUsd: 15, cacheReadUsd: 0.3 },
  { match: /opus|fable|mythos/i, inUsd: 15, outUsd: 75, cacheReadUsd: 1.5 },
  { match: /deepseek/i, inUsd: 0.27, outUsd: 1.1, cacheReadUsd: 0.07 },
  { match: /gpt-4o-mini|gpt-5-mini|mini/i, inUsd: 0.15, outUsd: 0.6, cacheReadUsd: 0.075 },
];

export function estimateCostUsd(model: string, usage: AiUsage): number {
  const envIn = Number(process.env.AI_PRICE_IN);
  const envOut = Number(process.env.AI_PRICE_OUT);
  const p = PRICES.find((x) => x.match.test(model)) ?? { inUsd: 3, outUsd: 15, cacheReadUsd: 0.3 };
  const inUsd = Number.isFinite(envIn) && envIn > 0 ? envIn : p.inUsd;
  const outUsd = Number.isFinite(envOut) && envOut > 0 ? envOut : p.outUsd;
  return (usage.inputTokens * inUsd + usage.outputTokens * outUsd + usage.cacheReadTokens * p.cacheReadUsd) / 1_000_000;
}

export function aiConfigFromEnv(): AiConfig | null {
  const provider = (process.env.AI_PROVIDER?.trim().toLowerCase() as AiProvider | undefined) ?? "anthropic";
  const maxOutputTokens = Math.min(2000, Math.max(200, Number(process.env.AI_MAX_OUTPUT_TOKENS) || 700));
  if (provider === "openai") {
    const apiKey = process.env.AI_API_KEY?.trim();
    if (!apiKey) return null;
    return { provider, model: process.env.AI_MODEL?.trim() || "deepseek-chat", apiKey, baseUrl: (process.env.AI_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/+$/, ""), maxOutputTokens };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  return { provider: "anthropic", model: process.env.AI_MODEL?.trim() || "claude-haiku-4-5", apiKey, maxOutputTokens };
}

export interface StructuredResult<T> {
  output: T | null;
  usage: AiUsage;
  costUsd: number;
}

/** JSON Schema text for prompt-level guidance on providers without native structured outputs. */
function jsonSchemaText(schema: z.ZodType): string {
  try {
    const js = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
    delete js.$schema;
    return JSON.stringify(js);
  } catch {
    return "{}";
  }
}

/** Ask for a structured object; `schema` is enforced by the API (Anthropic) or validated after the fact (OpenAI-compatible JSON mode). */
/** Human-readable reason for an upstream model error, so the UI can show it instead of a bare status code. */
async function describeHttpError(provider: string, res: Response): Promise<string> {
  let upstream = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string };
    upstream = (typeof body.error === "string" ? body.error : body.error?.message) ?? body.message ?? "";
  } catch {
    /* no JSON body */
  }
  const why =
    res.status === 401 ? "the API key was rejected" :
    res.status === 402 ? "the model account has no credit left; top it up or switch AI_PROVIDER" :
    res.status === 403 ? "the API key is not allowed to use this model" :
    res.status === 404 ? "the configured model was not found at this endpoint" :
    res.status === 429 ? "the model provider is rate limiting us; try again in a minute" :
    res.status >= 500 ? "the model provider is having an outage" : "the model provider refused the request";
  const detail = upstream ? ` (${upstream.slice(0, 140)})` : "";
  return `AI assistant unavailable: ${why} — ${provider} answered ${res.status}${detail}.`;
}

export async function generateStructured<T>(cfg: AiConfig, opts: { system: string; user: string; schema: z.ZodType<T>; timeoutMs?: number; /** Per-call output cap; defaults to AI_MAX_OUTPUT_TOKENS. */ maxTokens?: number }): Promise<StructuredResult<T>> {
  const started = Date.now();
  if (cfg.provider === "anthropic") {
    const client = new Anthropic({ apiKey: cfg.apiKey, maxRetries: 1, timeout: opts.timeoutMs ?? 30_000 });
    const response = await client.messages.parse({
      model: cfg.model,
      max_tokens: opts.maxTokens ?? cfg.maxOutputTokens,
      system: opts.system,
      output_config: { format: zodOutputFormat(opts.schema) },
      messages: [{ role: "user", content: opts.user }],
    });
    const usage: AiUsage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, cacheReadTokens: response.usage.cache_read_input_tokens ?? 0 };
    metrics.count("ai.intent", true, String(Date.now() - started));
    const output = response.stop_reason === "refusal" || !response.parsed_output ? null : (response.parsed_output as T);
    return { output, usage, costUsd: estimateCostUsd(cfg.model, usage) };
  }

  // OpenAI-compatible chat completions with JSON mode; the schema is validated server-side.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        max_tokens: opts.maxTokens ?? cfg.maxOutputTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${opts.system}\n\nRespond with a single JSON object only, using exactly these keys and types (JSON Schema):\n${jsonSchemaText(opts.schema)}` },
          { role: "user", content: opts.user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new AppError("PROVIDER_UNAVAILABLE", await describeHttpError(cfg.provider, res), 502);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number } };
    const usage: AiUsage = { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0, cacheReadTokens: data.usage?.prompt_cache_hit_tokens ?? 0 };
    metrics.count("ai.intent", true, String(Date.now() - started));
    const text = data.choices?.[0]?.message?.content ?? "";
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
    } catch {
      parsed = null;
      metrics.count("ai.parse", false, `not json: ${text.slice(0, 160)}`);
    }
    const checked = parsed ? opts.schema.safeParse(parsed) : null;
    if (checked && !checked.success) metrics.count("ai.parse", false, `schema: ${checked.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    return { output: checked?.success ? checked.data : null, usage, costUsd: estimateCostUsd(cfg.model, usage) };
  } finally {
    clearTimeout(timer);
  }
}
