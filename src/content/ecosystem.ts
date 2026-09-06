/**
 * Sibling products under the basestocks.finance umbrella. One constant so the footer, the
 * integrations page and the per-stock launchpad module never drift apart. The env override
 * exists for previews pointing at a launchpad preview deployment.
 */
export const LAUNCHPAD_URL = process.env.NEXT_PUBLIC_LAUNCHPAD_URL ?? "https://launchpad.basestocks.finance";
export const LAUNCHPAD_NAME = "StockPair";

export function launchpadTokenUrl(token: string): string {
  return `${LAUNCHPAD_URL}/token/${token}`;
}

export function launchpadMarketsUrl(stock: string): string {
  return `${LAUNCHPAD_URL}/markets?stock=${stock}`;
}
