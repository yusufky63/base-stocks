/**
 * When the eligibility modal should be on screen, kept apart from the component so the rule can be
 * tested without a DOM. The modal is asked once per browser session; after a dismissal it returns
 * only on a surface where an order or a deposit can actually be placed, and only after a day.
 */

export const ASK_AGAIN_AFTER_MS = 24 * 60 * 60 * 1000;

/** Where an order or a deposit can actually be placed, so the question is worth repeating there. */
const TRADING_PREFIXES = ["/stocks", "/build", "/earn", "/gifts", "/pools", "/automate"];

export function isTradingSurface(path: string): boolean {
  return TRADING_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** "never" asked-and-closed this session; "recent" closed within the day; "stale" closed longer ago. */
export type Dismissal = "never" | "recent" | "stale";

export function classifyDismissal(dismissedAt: number | null, now: number): Dismissal {
  if (dismissedAt === null) return "never";
  return now - dismissedAt > ASK_AGAIN_AFTER_MS ? "stale" : "recent";
}

/** Whether the question should be on screen for this page given how (if at all) it was dismissed. */
export function shouldAsk(dismissal: Dismissal, path: string): boolean {
  if (dismissal === "never") return true;
  return dismissal === "stale" && isTradingSurface(path);
}
