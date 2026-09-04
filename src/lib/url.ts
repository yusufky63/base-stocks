/**
 * Link handling for creator-supplied URLs (gift-pool steps).
 *
 * Only http(s) is ever accepted. `new URL()` — and therefore Zod's `.url()` — happily parses
 * `javascript:` and `data:`, and these links are handed straight to `window.open`, so the scheme
 * check is the guard, not a nicety.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Hostname without `www.`, for labelling a link the creator did not name. */
export function prettyHost(value: string): string {
  try {
    return new URL(value.trim()).hostname.replace(/^www\./, "");
  } catch {
    return value.trim().slice(0, 40);
  }
}
