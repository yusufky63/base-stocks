import type { DayRollup } from "@/domain/stats";
import { dayKey, extractEvents, type State, type StatsInput } from "./extract";
import { breakdown, summarize } from "./summarize";

/**
 * One finished day, reduced. The same extraction as the live computation, kept to the events
 * whose block time falls on `day`, so a day rolled up and a day computed live add to the same
 * totals. Records handed in should cover the day generously (a claim's record was created when
 * its link was funded, weeks before); the filter on `at` does the rest.
 */
export function buildDayRollup(input: StatsInput, day: string): DayRollup {
  const x = extractEvents(input);
  const dayEvents = x.events.filter((e) => dayKey(e.at) === day);
  const verified = dayEvents.filter((e) => e.state === "verified");
  const { summary, wallets } = summarize(dayEvents, 0, [], []);
  const b = breakdown(verified, x.assetByTx);
  const hashes = new Map<string, State>();
  for (const e of dayEvents) if (!hashes.has(e.txHash) || e.state === "verified") hashes.set(e.txHash, e.state);
  let verifiedTx = 0;
  let revertedTx = 0;
  for (const state of hashes.values()) {
    if (state === "verified") verifiedTx += 1;
    else if (state === "reverted") revertedTx += 1;
  }
  const { wallets: _w, basketsBuilt: _b, planRuns: _p, planRunUsd: _u, ...counters } = summary;
  void _w;
  void _b;
  void _p;
  void _u;
  return {
    day,
    events: verified.length,
    wallets: [...wallets],
    summary: counters,
    byProvider: Object.fromEntries(b.byProvider),
    byAsset: Object.fromEntries(b.byAsset),
    earnByProvider: Object.fromEntries(b.earnByProvider),
    liquidity: b.liquidity,
    feeUsd: b.feeUsd,
    verifiedTx,
    revertedTx,
    computedAt: input.now,
  };
}
