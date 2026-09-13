/**
 * The USD figure a record keeps when the receipt cannot settle it.
 *
 * A trade paid in USDC is worth what the receipt says it is, to the cent. A buy paid in ETH, a
 * basket leg that shared one transaction with three others, or a liquidity action has no single
 * USDC leg to read, and the record used to keep whatever the browser sent, without a ceiling. The
 * browser's figure is still the most accurate one when it is honest (it saw the quote), so it is
 * kept when it sits within `USD_TOLERANCE` of what the receipt's own token amounts are worth at the
 * stock's price; outside that band the estimate replaces it. No price known means no ceiling, and
 * the figure stays as sent.
 */
export const USD_TOLERANCE = 0.25;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function boundedUsd(client: number | null | undefined, estimate: number | null): number | null {
  const c = client !== null && client !== undefined && Number.isFinite(client) && client > 0 ? client : null;
  if (estimate === null || !Number.isFinite(estimate) || estimate <= 0) return c;
  if (c === null) return round2(estimate);
  return c >= estimate * (1 - USD_TOLERANCE) && c <= estimate * (1 + USD_TOLERANCE) ? c : round2(estimate);
}
