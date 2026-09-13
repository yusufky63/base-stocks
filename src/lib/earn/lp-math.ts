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

/* ---------------- Mint-side helpers (inverse math) ---------------- */

/** Tick whose price equals `rawPrice` (token1 per token0, raw units). Not yet spacing-aligned. */
export function priceToTick(rawPrice: number): number {
  return Math.log(rawPrice) / Math.log(1.0001);
}

/** Nearest usable tick at or beyond `tick` in the given direction, clamped to the pool's absolute bounds. */
export function alignTick(tick: number, spacing: number, mode: "down" | "up"): number {
  const q = tick / spacing;
  const aligned = (mode === "down" ? Math.floor(q) : Math.ceil(q)) * spacing;
  const bound = Math.floor(887272 / spacing) * spacing;
  return Math.max(-bound, Math.min(bound, aligned));
}

/**
 * Liquidity that `amount0` raw token0 (or `amount1` raw token1) buys between two ticks at the
 * current sqrt price, plus the counterpart amount. Exactly one side must be given; a range fully
 * above the price needs only token1, fully below only token0.
 */
export function amountsForOneSide(sqrtPrice: number, tickLower: number, tickUpper: number, given: { amount0: number } | { amount1: number }): { liquidity: number; amount0: number; amount1: number } {
  const sqrtA = tickToSqrtPrice(tickLower);
  const sqrtB = tickToSqrtPrice(tickUpper);
  const p = Math.min(Math.max(sqrtPrice, sqrtA), sqrtB);
  let liquidity: number;
  if ("amount0" in given) {
    const denom = 1 / p - 1 / sqrtB;
    liquidity = denom > 0 ? given.amount0 / denom : 0; // p == sqrtB → token0 buys nothing here
  } else {
    const denom = p - sqrtA;
    liquidity = denom > 0 ? given.amount1 / denom : 0;
  }
  const amount0 = liquidity * Math.max(0, 1 / p - 1 / sqrtB);
  const amount1 = liquidity * Math.max(0, p - sqrtA);
  return { liquidity, amount0, amount1 };
}
/* ---------------- Display helpers ---------------- */

/**
 * A position's price range in USD per one stock token. The pool prices token0 in token1; when the
 * stock is token0 the quote's USD price converts directly, when it is token1 the price is inverted
 * first. Null when neither side is a stock or the quote has no USD price.
 */
export function rangeUsd(
  pos: { tickLower: number; tickUpper: number; currentTick: number },
  token0: { decimals: number; isStock: boolean; priceUsd: number | null },
  token1: { decimals: number; isStock: boolean; priceUsd: number | null },
): { lower: number; upper: number; current: number } | null {
  if (!token0.isStock && !token1.isStock) return null;
  const stockIs0 = token0.isStock;
  const quote = stockIs0 ? token1 : token0;
  if (quote.priceUsd === null || !Number.isFinite(quote.priceUsd)) return null;
  const conv = (tick: number) => {
    const p01 = tickToPrice(tick, token0.decimals, token1.decimals); // token1 per token0
    return stockIs0 ? p01 * quote.priceUsd! : (1 / p01) * quote.priceUsd!;
  };
  const lower = conv(pos.tickLower);
  const upper = conv(pos.tickUpper);
  return { lower: Math.min(lower, upper), upper: Math.max(lower, upper), current: conv(pos.currentTick) };
}
