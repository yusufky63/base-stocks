import { AppError } from "@/lib/errors";
import { getSupabaseAdmin } from "@/db/supabase";
import { hashIp } from "@/lib/ai-quota";
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

/**
 * Durable fixed-window limit on top of the memory bucket, for write/expensive routes only.
 * Serverless instances share nothing, so the in-memory bucket resets on every cold start; the
 * shared counter in Supabase (`ai_usage` + its atomic increment RPC, window index folded into the
 * key) survives instances. Storage being down fails open: the memory bucket has already run.
 */
export async function enforceDurableRateLimit(req: Request, route: string, opts: RateLimitOptions): Promise<void> {
  enforceRateLimit(req, route, opts);
  const sb = getSupabaseAdmin();
  if (!sb) return;
  const windowIdx = Math.floor(Date.now() / opts.windowMs);
  const key = `rl:${route}:${hashIp(clientKey(req))}:${windowIdx}`;
  try {
    const { data, error } = await sb.rpc("ai_usage_increment", { p_key: key, p_day: new Date().toISOString().slice(0, 10) });
    if (error || typeof data !== "number") {
      metrics.count("ratelimit.db", false, error?.message ?? "bad rpc result");
      return;
    }
    if (data > opts.limit) throw new AppError("RATE_LIMITED", "Too many requests. Please slow down.", 429);
  } catch (err) {
    if (err instanceof AppError) throw err;
    metrics.count("ratelimit.db", false, err instanceof Error ? err.message : String(err));
  }
}
