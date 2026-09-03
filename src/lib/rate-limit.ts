import { AppError } from "@/lib/errors";

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

function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
  return ip;
}

/** Token-bucket limiter keyed by route + client ip. Throws AppError(429) when exhausted. */
export function enforceRateLimit(req: Request, route: string, opts: RateLimitOptions): void {
  const key = `${route}:${clientKey(req)}`;
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
