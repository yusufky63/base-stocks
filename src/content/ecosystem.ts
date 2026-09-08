/**
 * Sibling products under the basestocks.finance umbrella. One constant so the footer, the
 * integrations page and the per-stock launchpad module never drift apart. The env override
 * exists for previews pointing at a launchpad preview deployment.
 */
export const LAUNCHPAD_URL = process.env.NEXT_PUBLIC_LAUNCHPAD_URL ?? "https://launchpad.basestocks.finance";
/**
 * What the launchpad calls itself. It ships under the BaseStocks wordmark with a LAUNCHPAD eyebrow
 * and titles its own pages "BaseStocks Launchpad", so calling it anything else here sends a reader
 * looking for a name that appears nowhere once they arrive.
 */
export const LAUNCHPAD_NAME = "BaseStocks Launchpad";

export function launchpadTokenUrl(token: string): string {
  return `${LAUNCHPAD_URL}/token/${token}`;
}

export function launchpadMarketsUrl(stock: string): string {
  return `${LAUNCHPAD_URL}/markets?stock=${stock}`;
}
