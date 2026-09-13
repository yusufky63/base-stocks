import { createHash } from "node:crypto";
import { AppError } from "@/lib/errors";
import { getSupabaseAdmin } from "@/db/supabase";
import { metrics } from "@/lib/http";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

/** Short, stable hash of an IP for keys and rows: the address itself is never stored. */
export function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

/**
 * Whether `x-forwarded-for` was written by a proxy we control.
 *
 * Vercel (and any deployment that says so with `TRUSTED_PROXY`) sets the header itself and
 * overwrites whatever the client sent, so its first hop is the client. Anywhere else the header is
 * client-supplied text, and honouring it lets one machine pose as a thousand addresses and walk
 * past every per-IP limit here. In that case the connection's own hint (`x-real-ip`) is used and,
 * failing that, every caller shares one bucket, which is strict rather than porous.
 */
function trustsForwardedFor(): boolean {
  return !!process.env.VERCEL || process.env.TRUSTED_PROXY === "1" || process.env.TRUSTED_PROXY === "true";
}

/** The caller's IP as the hosting layer reports it; "local" when nothing does. One definition for every limiter. */
export function clientIp(req: Request): string {
  if (trustsForwardedFor()) {
    const fwd = req.headers.get("x-forwarded-for");
    const first = fwd?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "local";
}

/** Token-bucket limiter keyed by route + client ip. Throws AppError(429) when exhausted. */
export function enforceRateLimit(req: Request, route: string, opts: RateLimitOptions): void {
  const key = `${route}:${clientIp(req)}`;
  const now = Date.now();
  const refillPerMs = opts.limit / opts.windowMs;
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: opts.limit, updatedAt: now };
    buckets.set(key, b);
  }
  b.tokens = Math.min(opts.limit, b.tokens + (now - b.updatedAt) * refillPerMs);
  b.updatedAt = now;
  if (b.tokens < 1) {
    throw new AppError("RATE_LIMITED", "Too many requests. Please slow down.", 429);
  }
  b.tokens -= 1;

  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (now - v.updatedAt > opts.windowMs * 2) buckets.delete(k);
  }
}

/** Which fixed window `now` falls in, and the day it belongs to (the sweep prunes by day). Pure, for tests. */
export function windowKey(route: string, ipHash: string, windowMs: number, now = Date.now()): { key: string; day: string } {
  const windowIdx = Math.floor(now / windowMs);
  return { key: `rl:${route}:${ipHash}:${windowIdx}`, day: new Date(now).toISOString().slice(0, 10) };
}

/**
 * Count one event in the shared fixed window and return the count so far, or null when the shared
 * counter is not available. Nothing is thrown: the caller decides what the number means.
 */
export async function countDurableWindow(req: Request, route: string, windowMs: number): Promise<number | null> {
  const sb = getSupabaseAdmin();
  if (!sb) return null;
  const { key, day } = windowKey(route, hashIp(clientIp(req)), windowMs);
  try {
    const { data, error } = await sb.rpc("ai_usage_increment", { p_key: key, p_day: day });
    if (error || typeof data !== "number") {
      metrics.count("ratelimit.db", false, error?.message ?? "bad rpc result");
      return null;
    }
    return data;
  } catch (err) {
    metrics.count("ratelimit.db", false, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Durable fixed-window limit on top of the memory bucket, for write/expensive routes only.
 * Serverless instances share nothing, so the in-memory bucket resets on every cold start; the
 * shared counter in Supabase (`ai_usage` + its atomic increment RPC, window index folded into the
 * key) survives instances. Storage being down fails open: the memory bucket has already run.
 */
export async function enforceDurableRateLimit(req: Request, route: string, opts: RateLimitOptions): Promise<void> {
  enforceRateLimit(req, route, opts);
  const count = await countDurableWindow(req, route, opts.windowMs);
  if (count !== null && count > opts.limit) throw new AppError("RATE_LIMITED", "Too many requests. Please slow down.", 429);
}
