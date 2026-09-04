/**
 * Country of the incoming request as the hosting layer reports it (Vercel, Cloudflare, or the
 * plain header used in tests). Uppercase ISO code, or null when no edge added one (local dev).
 * Shared by the region endpoint and per-provider gates so every gate agrees on the answer.
 */
export function requestCountry(req: Request): string | null {
  const country = (req.headers.get("x-vercel-ip-country") ?? req.headers.get("cf-ipcountry") ?? req.headers.get("x-country-code") ?? "").toUpperCase();
  return country || null;
}
