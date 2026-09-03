import { touchActivity } from "@/lib/activity-pulse";
import { z } from "zod";
import { AppError, errorResponse } from "@/lib/errors";
import { enforceRateLimit, type RateLimitOptions } from "@/lib/rate-limit";
import { normalizeAddress } from "@/lib/address";
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
  rateLimit?: RateLimitOptions & { key: string };
}

/** Wrap a route handler with error mapping + optional rate limiting. */
export function route<Ctx = unknown>(opts: RouteOptions, handler: Handler<Ctx>): Handler<Ctx> {
  return async (req, ctx) => {
    touchActivity();
    try {
      if (opts.rateLimit) enforceRateLimit(req, opts.rateLimit.key, opts.rateLimit);
      return await handler(req, ctx);
    } catch (err) {
      if (!(err instanceof AppError) || err.httpStatus >= 500) {
        console.error(`[api] ${new URL(req.url).pathname}`, err instanceof Error ? err.message : err);
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

export function requireAdmin(req: Request, token: string | undefined): void {
  const provided = req.headers.get("x-admin-token");
  if (!token || !provided || provided !== token) throw new AppError("UNAUTHORIZED", "Admin token required", 401);
}
