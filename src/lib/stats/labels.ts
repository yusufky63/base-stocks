import type { LedgerKind } from "@/domain/stats";

/** What each verified ledger line is called wherever it is shown — the stats page and the public feed agree. */
export const LEDGER_LABEL: Record<LedgerKind, string> = {
  buy: "Bought",
  sell: "Sold",
  gift: "Gift",
  link: "Gift link funded",
  "link-claim": "Gift link claimed",
  pool: "Pool funded",
  "pool-claim": "Pool share claimed",
  "earn-deposit": "Earn deposit",
  "earn-withdraw": "Earn withdrawal",
  "lp-add": "Liquidity added",
  "lp-remove": "Liquidity withdrawn",
  "lp-collect": "LP fees collected",
  basket: "Basket",
  "plan-run": "Plan run",
};

/** Tone for a ledger line: money coming into stocks reads positive, leaving reads negative, the rest neutral. */
export function ledgerTone(kind: LedgerKind): "positive" | "negative" | "neutral" {
  if (kind === "buy" || kind === "link-claim" || kind === "pool-claim" || kind === "basket" || kind === "plan-run") return "positive";
  if (kind === "sell") return "negative";
  return "neutral";
}
