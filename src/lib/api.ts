import { timingSafeEqual } from "node:crypto";
import { touchActivity } from "@/lib/activity-pulse";
import { z } from "zod";
import { AppError, errorResponse } from "@/lib/errors";
import { recordError } from "@/lib/error-sink";
import { enforceDurableRateLimit, enforceRateLimit, type RateLimitOptions } from "@/lib/rate-limit";
import { normalizeAddress } from "@/lib/address";
import { publicEnv } from "@/config/env";
import type { Address } from "viem";

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Invalid address")
  .transform((v) => normalizeAddress(v));

export const bigintStringSchema = z
  .string()
  .regex(/^\d+$/, "Expected an integer string")
  .transform((v) => BigInt(v));

export const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Invalid transaction hash");

type Handler<Ctx> = (req: Request, ctx: Ctx) => Promise<Response>;

interface RouteOptions {
  /** `durable: true` adds a shared Supabase window counter that survives serverless instances. */
  rateLimit?: RateLimitOptions & { key: string; durable?: boolean };
}

/** Wrap a route handler with error mapping + optional rate limiting. */
/**
 * Cross-site writes are refused. The session cookies travel `SameSite=None` so the Base app can
 * embed the site, which means a form on any other site could post them here; the browser's
 * `Origin` header (sent on every cross-origin write, and on same-origin fetches) is the check
 * Lax used to do for free. A request without one (curl, the cron, the Telegram bot) is not a
 * browser and is left to the bearer or session it carries.
 */
function assertSameOrigin(req: Request): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  const origin = req.headers.get("origin");
  if (!origin) return;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    throw new AppError("UNAUTHORIZED", "Cross-site request refused.", 403);
  }
  const own = new Set<string>();
  try {
    own.add(new URL(req.url).host.toLowerCase());
  } catch {
    /* the request URL is always absolute in a route handler */
  }
  const forwarded = req.headers.get("x-forwarded-host");
  if (forwarded) own.add(forwarded.split(",")[0]!.trim().toLowerCase());
  try {
    own.add(new URL(publicEnv.appUrl).host.toLowerCase());
  } catch {
    /* unset in a test */
  }
  if (own.has(host) || host.endsWith(".vercel.app") || host === "localhost" || host.startsWith("localhost:")) return;
  throw new AppError("UNAUTHORIZED", "Cross-site request refused.", 403);
}

export function route<Ctx = unknown>(opts: RouteOptions, handler: Handler<Ctx>): Handler<Ctx> {
  return async (req, ctx) => {
    touchActivity();
    try {
      assertSameOrigin(req);
      if (opts.rateLimit) {
        if (opts.rateLimit.durable) await enforceDurableRateLimit(req, opts.rateLimit.key, opts.rateLimit);
        else enforceRateLimit(req, opts.rateLimit.key, opts.rateLimit);
      }
      return await handler(req, ctx);
    } catch (err) {
      if (!(err instanceof AppError) || err.httpStatus >= 500) {
        const path = new URL(req.url).pathname;
        console.error(`[api] ${path}`, err instanceof Error ? err.message : err);
        void recordError({ source: "route", route: path, message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined, meta: { method: req.method } });
      }
      return errorResponse(err);
    }
  };
}

export async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError("BAD_REQUEST", "Invalid JSON body", 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), 400);
  }
  return parsed.data;
}

export function parseQuery<T>(req: Request, schema: z.ZodType<T>): T {
  const url = new URL(req.url);
  const obj: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (obj[k] = v));
  const parsed = schema.safeParse(obj);
  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", parsed.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; "), 400);
  }
  return parsed.data;
}

export async function addressParam(params: Promise<{ address: string }>): Promise<Address> {
  const { address } = await params;
  const parsed = addressSchema.safeParse(address);
  if (!parsed.success) throw new AppError("BAD_REQUEST", "Invalid address", 400);
  return parsed.data;
}

export function json(data: unknown, init?: { status?: number; cacheSeconds?: number; staleSeconds?: number }): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init?.cacheSeconds !== undefined) {
    headers["cache-control"] = `public, s-maxage=${init.cacheSeconds}, stale-while-revalidate=${init.staleSeconds ?? init.cacheSeconds * 4}`;
  } else {
    headers["cache-control"] = "no-store";
  }
  return new Response(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), { status: init?.status ?? 200, headers });
}

/**
 * Constant-time comparison of two secrets. `!==` short-circuits on the first differing byte, and
 * a caller that can time responses learns the token one character at a time; a mismatch in length
 * is answered in the same time as a mismatch in content.
 */
export function secretEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) {
    // Compare something of equal length anyway so the length mismatch does not return early.
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}

export function requireAdmin(req: Request, token: string | undefined): void {
  const provided = req.headers.get("x-admin-token");
  if (!token || !secretEquals(provided, token)) throw new AppError("UNAUTHORIZED", "Admin token required", 401);
}

/** Throws 401 unless the request carries `Authorization: Bearer <CRON_SECRET>`. Shared by every scheduled route. */
export function requireCron(req: Request, secret: string | undefined): void {
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!secret || !secretEquals(provided, secret)) throw new AppError("UNAUTHORIZED", "Cron secret required", 401);
}
