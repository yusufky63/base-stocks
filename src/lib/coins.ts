/**
 * 3D coin renders shipped in public/brand/coins, keyed by underlying ticker.
 * Only a subset of the list has a render; everything else falls back to the flat token logo.
 */
const COINS: Record<string, string> = {
  AAPL: "aapl",
  GOOGL: "googl",
  META: "meta",
  MSFT: "msft",
  NVDA: "nvda",
  TSLA: "tsla",
};

/** Path under /public for a ticker's coin, or null when there is no render. "small" is the 200px variant. */
export function coinSrc(underlying: string | undefined | null, variant: "full" | "small" = "small"): string | null {
  const key = underlying ? COINS[underlying.toUpperCase()] : undefined;
  return key ? `/brand/coins/${key}${variant === "small" ? "-200" : ""}.png` : null;
}

export function hasCoin(underlying?: string | null): boolean {
  return coinSrc(underlying) !== null;
}
