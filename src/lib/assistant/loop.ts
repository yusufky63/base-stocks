import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";
import type { AiConfig, AiUsage } from "@/lib/ai-provider";
import { generateChatTurn, type NormMessage, type ToolSpec } from "./model";
import { TOOLS_BY_NAME, type ToolCtx } from "./tools";
import { INFO_ACTION_KINDS, type AssistantAction } from "./schema";

const MAX_ROUNDS = 4;
/** Cards that lead to a signature; informational cards (news) are budgeted separately. */
const MAX_DRAFT_ACTIONS = 2;
const MAX_INFO_ACTIONS = 2;
const WALL_CLOCK_MS = 40_000;

export interface AssistantTurnResult {
  reply: string;
  actions: AssistantAction[];
  usage: AiUsage;
  costUsd: number;
}

/**
 * The tool-use loop for one user turn. Tool failures become short data strings for the model
 * (the turn survives); provider failures throw. The loop is bounded three ways: rounds, wall
 * clock, and a final forced no-tools round so the turn always ends in text.
 */
export async function runAssistantTurn(cfg: AiConfig, opts: { system: string; history: NormMessage[]; tools: ToolSpec[]; ctx: ToolCtx }): Promise<AssistantTurnResult> {
  const started = Date.now();
  const messages: NormMessage[] = [...opts.history];
  const actions: AssistantAction[] = [];
  const usage: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let costUsd = 0;
  let lastText: string | null = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const timeLeft = WALL_CLOCK_MS - (Date.now() - started);
    if (timeLeft < 4_000) break;
    // The last permitted round runs without tools so the turn always closes with an answer.
    const drafts = actions.filter((a) => !INFO_ACTION_KINDS.has(a.kind)).length;
    const allowTools = round < MAX_ROUNDS - 1 && drafts < MAX_DRAFT_ACTIONS;
    const turn = await generateChatTurn(cfg, { system: opts.system, messages, tools: opts.tools, allowTools, timeoutMs: Math.min(30_000, timeLeft), maxTokens: Math.max(700, cfg.maxOutputTokens) });
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;
    usage.cacheReadTokens += turn.usage.cacheReadTokens;
    costUsd += turn.costUsd;
    lastText = turn.text ?? lastText;

    if (turn.toolCalls.length === 0) break;

    messages.push({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls });
    for (const call of turn.toolCalls) {
      const tool = TOOLS_BY_NAME.get(call.name);
      let content: string;
      if (!tool) {
        content = `error: unknown tool ${call.name.slice(0, 40)}`;
      } else {
        const parsed = tool.schema.safeParse(call.input ?? {});
        if (!parsed.success) {
          content = `error: invalid input — ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`.slice(0, 300);
        } else {
          try {
            const out = await tool.run(opts.ctx, parsed.data);
            content = out.forModel;
            if (out.action) {
              const info = INFO_ACTION_KINDS.has(out.action.kind);
              const used = actions.filter((a) => INFO_ACTION_KINDS.has(a.kind) === info).length;
              if (used < (info ? MAX_INFO_ACTIONS : MAX_DRAFT_ACTIONS)) actions.push(out.action);
            }
          } catch (err) {
            content = `error: tool failed (${err instanceof Error ? err.message.slice(0, 120) : "unknown"})`;
            metrics.count("assistant.tool", false, `${call.name}: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
          }
        }
      }
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
    }
  }

  if (!lastText) throw new AppError("PROVIDER_UNAVAILABLE", "assistant: no reply", 502);
  return { reply: lastText, actions, usage, costUsd };
}
