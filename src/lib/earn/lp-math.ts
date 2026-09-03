/**
 * Concentrated-liquidity position math (Uniswap v3 / Aerodrome Slipstream share the model).
 * Display precision only: liquidity and sqrt prices are handled as floating point, which is fine
 * for values and ranges shown to users; nothing here builds calldata.
 */
const Q96 = 2 ** 96;

/** sqrt(1.0001^tick) as a plain number (raw token1 per raw token0, square-rooted). */
export function tickToSqrtPrice(tick: number): number {
  return Math.pow(1.0001, tick / 2);
}

/** Price of one raw token0 in raw token1 at `tick`, adjusted to human units with decimals. */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return Math.pow(1.0001, tick) * 10 ** (decimals0 - decimals1);
}

export function sqrtPriceX96ToSqrtPrice(sqrtPriceX96: bigint): number {
  return Number(sqrtPriceX96) / Q96;
}

/** Token amounts (raw units) currently backing `liquidity` between two ticks at the pool's sqrt price. */
export function amountsForLiquidity(liquidity: bigint, sqrtPrice: number, tickLower: number, tickUpper: number): { amount0: number; amount1: number } {
  const L = Number(liquidity);
  const sqrtA = tickToSqrtPrice(tickLower);
  const sqrtB = tickToSqrtPrice(tickUpper);
  if (sqrtPrice <= sqrtA) return { amount0: L * (1 / sqrtA - 1 / sqrtB), amount1: 0 };
  if (sqrtPrice >= sqrtB) return { amount0: 0, amount1: L * (sqrtB - sqrtA) };
  return { amount0: L * (1 / sqrtPrice - 1 / sqrtB), amount1: L * (sqrtPrice - sqrtA) };
}

export function inRange(tick: number, tickLower: number, tickUpper: number): boolean {
  return tick >= tickLower && tick < tickUpper;
}
