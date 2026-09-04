/**
 * Estimated LP fee APY in percent: 24h volume x fee rate, annualized over pool TVL.
 * Undefined when the pool is too shallow to trust (dust pools wash-trade absurd numbers)
 * or the result is implausible. Concentrated liquidity concentrates fees on in-range
 * capital, so this understates an active position - it is a floor, labeled "estimated".
 */
export function estimateFeeApyPct(volume24hUsd: number | null | undefined, feeRate: number | null | undefined, liquidityUsd: number | null | undefined): number | undefined {
  if (!volume24hUsd || !feeRate || !liquidityUsd || liquidityUsd < 10_000) return undefined;
  const apy = ((volume24hUsd * feeRate * 365) / liquidityUsd) * 100;
  return apy > 0 && apy <= 500 ? apy : undefined;
}

/** Deep USDC pools are ordinary LP risk; thin or exotic-quoted pools stay "higher". */
export function liquidityRiskLabel(quoteSymbol: string | null | undefined, liquidityUsd: number | null | undefined): "medium" | "higher" {
  return quoteSymbol === "USDC" && (liquidityUsd ?? 0) >= 100_000 ? "medium" : "higher";
}
