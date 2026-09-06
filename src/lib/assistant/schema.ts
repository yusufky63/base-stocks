import { z } from "zod";
import type { Address } from "viem";

/** Client-safe address check (lib/api pulls server-only modules, so it is not imported here). */
const addressSchema = z.custom<Address>((v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v), "expected a 0x address");
import type { Allocation } from "@/domain/portfolio";
import type { AutomationDraft, DraftCommentary } from "@/lib/client-api";

/**
 * Wire types for the assistant chat. The client sends plain text history only; every action is
 * produced server-side from validated tool input, so addresses in actions never come from the
 * model — it works in symbols, the server resolves.
 */

export const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(2_000),
});

export const chatBodySchema = z.object({
  /** Oldest first; the last entry must be the user's new message. */
  messages: z.array(chatMessageSchema).min(1).max(12),
  /** Connected wallet, for the per-wallet quota and portfolio tools. Unauthenticated hint. */
  owner: addressSchema.optional(),
  /** Current pathname, for light context ("the user is looking at /stocks/…"). */
  path: z.string().max(120).optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatBody = z.infer<typeof chatBodySchema>;

export interface TradeAction {
  kind: "trade";
  side: "buy" | "sell";
  symbol: string;
  name: string;
  assetAddress: Address;
  /** Buy size in USD (buys) — the sold USDC amount. */
  amountUsd?: number;
  /** Sold share quantity (sells), in whole tokens. */
  quantity?: number;
  payWith: "USDC" | "ETH";
  indicative?: { priceUsd: number | null; estOut: string; provider: string; feeUsd: number | null };
}

export interface BasketAction {
  kind: "basket";
  intent: { name: string; allocations: Allocation[]; notes: string; source: "ai"; commentary: DraftCommentary };
}

export interface AutoInvestAction {
  kind: "autoinvest";
  draft: AutomationDraft;
}

export interface GiftAction {
  kind: "gift";
  symbol: string;
  name: string;
  assetAddress: Address;
  amountUsd?: number;
  quantity?: number;
  /** Basename or 0x address, exactly as the user gave it; the gift page resolves it. */
  recipient?: string;
}

export interface EarnAction {
  kind: "earn";
  opportunityId: string;
  provider: string;
  title: string;
  amountUsd: number;
  variableApy?: number;
}

/**
 * Headlines the assistant cited, with their real links. The model never writes a URL: these come
 * straight from the news service, so a link can only point where the feed pointed.
 */
export interface NewsAction {
  kind: "news";
  scope: "stock" | "market" | "ecosystem";
  symbol?: string;
  items: Array<{ title: string; url: string; source: string; publishedAt: number; ticker?: string }>;
}

export type AssistantAction = TradeAction | BasketAction | AutoInvestAction | GiftAction | EarnAction | NewsAction;

/** Cards that only inform (no signature ahead); they do not count against the draft budget. */
export const INFO_ACTION_KINDS = new Set<AssistantAction["kind"]>(["news"]);

export interface ChatResponse {
  ok: true;
  reply: string;
  actions: AssistantAction[];
  quota: { remainingForWallet: number; remainingForIp: number };
  warnings?: string[];
}
