/**
 * Rate conversions for the Earn venues, so one column on the page means one thing.
 *
 * The venues publish in different units. Morpho's `netApy` is already compounded; Aave's
 * `liquidityRate` is a linear annual rate (RAY) that compounds per second as interest accrues;
 * Compound's `getSupplyRate` is a per-second rate. Listing a linear APR next to a compounded APY
 * under one "APY" heading flatters the compounded venue by the spread between the two, which at
 * five percent is about thirteen basis points. Everything is converted to a compounded APY here.
 */
export const SECONDS_PER_YEAR = 31_536_000;

/** A linear annual rate (percent) compounded `periods` times a year, as a percent. Daily compounding is what Aave's own interface shows. */
export function aprToApyPct(aprPct: number, periods = 365): number {
  if (!Number.isFinite(aprPct) || aprPct <= 0 || periods <= 0) return Math.max(0, aprPct || 0);
  const apr = aprPct / 100;
  return (Math.pow(1 + apr / periods, periods) - 1) * 100;
}

/** A per-second rate (a fraction, not a percent) compounded every second for a year, as a percent. Compound's unit. */
export function perSecondRateToApyPct(ratePerSecond: number): number {
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) return 0;
  // (1 + r)^n - 1 through exp/log1p: r is ~1e-9, and 1 + r would lose most of it in a double.
  return (Math.exp(SECONDS_PER_YEAR * Math.log1p(ratePerSecond)) - 1) * 100;
}

/** The linear APR a per-second rate implies, as a percent; what Compound's interface labels "APR". */
export function perSecondRateToAprPct(ratePerSecond: number): number {
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) return 0;
  return ratePerSecond * SECONDS_PER_YEAR * 100;
}
