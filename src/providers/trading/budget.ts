/**
 * Time budgets shared by the router and the adapters.
 *
 * The router races every provider's indicative quote against one budget and moves on without the
 * stragglers. The adapters' own fetch timeouts used to run on past that point (4.5-6 s), so a
 * provider the comparison had already given up on could still fail a few seconds later and count
 * that failure toward its circuit breaker, for an answer nobody was waiting for. Aborting the
 * fetch at the same moment the router stops listening keeps the two in step: one budget, one
 * failure, counted once.
 *
 * The adapter cannot take the router's signal (the shared fetch helper owns its own controller),
 * so the budget is the coupling instead.
 */

/** Per-provider budget for the comparison: a slow provider must not hold the sheet (guide §43). */
export const COMPARE_TIMEOUT_MS = 2_500;

/** What an adapter gives its indicative fetch: the comparison budget, so a late answer is aborted rather than counted. */
export const INDICATIVE_TIMEOUT_MS = COMPARE_TIMEOUT_MS;
