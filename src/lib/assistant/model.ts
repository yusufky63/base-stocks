import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { describeHttpError, estimateCostUsd, type AiConfig, type AiUsage } from "@/lib/ai-provider";

/**
 * One chat turn with tool calling, on either provider. `generateStructured` stays single-shot
 * for the draft endpoints; this adapter carries conversation history and tools for the
 * assistant. Both providers speak the same normalized message type so the loop upstream is
 * provider-agnostic.
 */

export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodType;
}

export type ToolCall = { id: string; name: string; input: unknown };

export type NormMessage =
  | { role: "user" | "assistant"; content: string }
  | { role: "assistant"; content: string | null; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ChatTurnResult {
  text: string | null;
  toolCalls: ToolCall[];
  usage: AiUsage;
  costUsd: number;
}

function jsonSchemaObject(schema: z.ZodType): Record<string, unknown> {
  try {
    const js = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
    delete js.$schema;
    return js;
  } catch {
    return { type: "object" };
  }
}

type AnthropicContent = Array<Record<string, unknown>>;

function toAnthropicMessages(messages: NormMessage[]): Array<{ role: "user" | "assistant"; content: string | AnthropicContent }> {
  const out: Array<{ role: "user" | "assistant"; content: string | AnthropicContent }> = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const prev = out[out.length - 1];
      // Consecutive tool results join one user message, as the API requires.
      if (prev && prev.role === "user" && Array.isArray(prev.content) && prev.content[0]?.type === "tool_result") prev.content.push(block);
      else out.push({ role: "user", content: [block] });
    } else if (m.role === "assistant" && "toolCalls" in m) {
      const content: AnthropicContent = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} });
      out.push({ role: "assistant", content });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function toOpenAiMessages(system: string, messages: NormMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    else if (m.role === "assistant" && "toolCalls" in m)
      out.push({
        role: "assistant",
        content: m.content ?? null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })),
      });
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

export async function generateChatTurn(
  cfg: AiConfig,
  opts: { system: string; messages: NormMessage[]; tools: ToolSpec[]; timeoutMs?: number; maxTokens?: number; allowTools?: boolean },
): Promise<ChatTurnResult> {
  const allowTools = opts.allowTools !== false && opts.tools.length > 0;

  if (cfg.provider === "anthropic") {
    // The SDK is imported where it is used, not at module load: only the types above are static.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: cfg.apiKey, maxRetries: 1, timeout: opts.timeoutMs ?? 30_000 });
    const response = await client.messages.create({
      model: cfg.model,
      max_tokens: opts.maxTokens ?? cfg.maxOutputTokens,
      system: opts.system,
      ...(allowTools ? { tools: opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: jsonSchemaObject(t.schema) as Anthropic.Tool["input_schema"] })) } : {}),
      messages: toAnthropicMessages(opts.messages) as Anthropic.MessageParam[],
    });
    const usage: AiUsage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, cacheReadTokens: response.usage.cache_read_input_tokens ?? 0 };
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const toolCalls: ToolCall[] = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input }));
    return { text: text || null, toolCalls, usage, costUsd: estimateCostUsd(cfg.model, usage) };
  }

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
        ...(allowTools ? { tools: opts.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: jsonSchemaObject(t.schema) } })) } : {}),
        messages: toOpenAiMessages(opts.system, opts.messages),
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new AppError("PROVIDER_UNAVAILABLE", await describeHttpError(cfg.provider, res), 502);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
    };
    const usage: AiUsage = { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0, cacheReadTokens: data.usage?.prompt_cache_hit_tokens ?? 0 };
    const msg = data.choices?.[0]?.message;
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).flatMap((c) => {
      try {
        return [{ id: c.id, name: c.function?.name ?? "", input: c.function?.arguments ? JSON.parse(c.function.arguments) : {} }];
      } catch {
        return [];
      }
    });
    return { text: msg?.content?.trim() || null, toolCalls, usage, costUsd: estimateCostUsd(cfg.model, usage) };
  } finally {
    clearTimeout(timer);
  }
}
