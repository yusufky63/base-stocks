/** BStocks on X. One constant so the footer, the share sheet and the pool quests never drift apart. */
export const BSTOCKS_X_HANDLE = "BaseOnStocks";
export const BSTOCKS_X_URL = `https://x.com/${BSTOCKS_X_HANDLE}`;

/** Strips a leading @ and anything that is not a legal X handle character. */
export function normalizeXHandle(input: string): string {
  return input.trim().replace(/^@+/, "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 15);
}

export function xProfileUrl(handle: string): string {
  return `https://x.com/${normalizeXHandle(handle)}`;
}

/** The numeric id at the end of a status URL, when the link is one. */
export function xTweetId(url: string): string | null {
  const m = /(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/(\d{5,25})/i.exec(url.trim());
  return m ? m[1]! : null;
}

/**
 * Where to send someone for a repost or a like. X's intent endpoints open the action directly
 * when the post id is readable; otherwise the post itself is the next best destination.
 */
export function xIntentUrl(action: "repost" | "like", tweetUrl: string): string {
  const id = xTweetId(tweetUrl);
  if (!id) return tweetUrl;
  return `https://x.com/intent/${action === "repost" ? "repost" : "like"}?tweet_id=${id}`;
}

export function isXPostUrl(url: string): boolean {
  return xTweetId(url) !== null;
}
