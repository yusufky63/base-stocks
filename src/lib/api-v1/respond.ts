import type { V1Envelope } from "./shape";

/**
 * The public API answers differently from the app's own routes: it is cross-origin (anyone may
 * call it from a browser), it is meant to be read by people and agents pasting URLs around, and
 * its cache window is part of the contract rather than an implementation detail. So it gets its
 * own responder instead of bending `lib/api.ts`, which stays the app's internal one.
 */

const DOCS_URL = "https://basestocks.finance/developers";

/** Wide open on purpose: every v1 route is public, read-only data about a public chain. */
export const V1_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type, x-payment, payment-signature",
  "access-control-max-age": "86400",
} as const;

export function v1Json<T>(data: T, opts: { cacheSeconds: number; staleSeconds?: number; status?: number }): Response {
  const body: V1Envelope<T> = {
    data,
    meta: { generatedAt: Date.now(), cacheSeconds: opts.cacheSeconds, docs: DOCS_URL },
  };
  return new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2), {
    status: opts.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // The CDN absorbs the reads: at s-maxage the origin sees one request per window per region
      // however many callers there are, which is what keeps a public API from costing anything.
      "cache-control": opts.cacheSeconds > 0 ? `public, s-maxage=${opts.cacheSeconds}, stale-while-revalidate=${opts.staleSeconds ?? opts.cacheSeconds * 10}` : "no-store",
      ...V1_CORS,
    },
  });
}

export function v1Error(status: number, code: string, message: string, hint?: string): Response {
  return new Response(JSON.stringify({ error: { code, message, ...(hint ? { hint } : {}) }, meta: { docs: DOCS_URL } }, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...V1_CORS },
  });
}

/** Preflight for browser callers. */
export function v1Options(): Response {
  return new Response(null, { status: 204, headers: V1_CORS });
}
