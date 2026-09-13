import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Address } from "viem";
import { AppError } from "@/lib/errors";
import { normalizeAddress } from "@/lib/address";

/**
 * Stateless, HMAC-signed session cookie created after a SIWE (Sign-In with Ethereum) proof.
 * No signature is ever requested on page load (spec §19); sign-in happens on the first action
 * that needs ownership (publishing a basket, voting, editing a profile, watchlist writes).
 */
export const SESSION_COOKIE = "bstocks_session";
export const NONCE_COOKIE = "bstocks_nonce";
const SESSION_TTL_S = 7 * 24 * 3600;

let secret: Buffer | null = null;
function getSecret(): Buffer {
  if (secret) return secret;
  const env = process.env.AUTH_SECRET?.trim();
  if (env && env.length >= 16) secret = Buffer.from(env, "utf8");
  else {
    // Sessions reset on restart without AUTH_SECRET; fine for development.
    secret = randomBytes(32);
    if (process.env.NODE_ENV === "production") console.warn("[auth] AUTH_SECRET is not set; sessions will not survive restarts");
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

export interface Session {
  address: Address;
  /** Unix seconds. */
  exp: number;
}

export function encodeSession(address: Address, ttlSeconds = SESSION_TTL_S): string {
  const payload = Buffer.from(JSON.stringify({ address, exp: Math.floor(Date.now() / 1000) + ttlSeconds }), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(token: string | undefined | null): Session | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { address?: string; exp?: number };
    if (!data.address || !data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return { address: normalizeAddress(data.address), exp: data.exp };
  } catch {
    return null;
  }
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== name) continue;
    // A cookie is whatever the client sent; a stray `%` made decodeURIComponent throw and a
    // malformed jar answered every request with a 500 instead of "not signed in".
    try {
      return decodeURIComponent(v.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Cookie attributes for the session, the nonce and the eligibility attestation.
 *
 * The site is embedded by the Base app and Farcaster clients (`frame-ancestors` in next.config),
 * and inside a cross-site iframe a browser leaves `SameSite=Lax` cookies at home: sign-in
 * answered "Sign-in expired" there and the attestation never stuck. `SameSite=None` sends them,
 * `Partitioned` (CHIPS) keeps the embedded copy separate from the top-level one, and the
 * same-origin check in `route()` (lib/api.ts) replaces the CSRF protection Lax used to give.
 * Both need `Secure`, so development on plain http keeps Lax.
 */
export function cookieAttributes(): string {
  return process.env.NODE_ENV === "production" ? "; HttpOnly; SameSite=None; Secure; Partitioned" : "; HttpOnly; SameSite=Lax";
}

export function cookieHeader(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}${cookieAttributes()}`;
}

export function clearCookieHeader(name: string): string {
  return `${name}=; Path=/; Max-Age=0${cookieAttributes()}`;
}

/** Session address or null. */
export function sessionAddress(req: Request): Address | null {
  return decodeSession(readCookie(req, SESSION_COOKIE))?.address ?? null;
}

/** Throws 401 unless the request carries a valid session. */
export function requireSession(req: Request): Address {
  const address = sessionAddress(req);
  if (!address) throw new AppError("UNAUTHORIZED", "Sign in with your wallet to continue.", 401);
  return address;
}

/** Throws 401/403 unless the session belongs to `owner`. */
export function requireOwner(req: Request, owner: Address): Address {
  const address = requireSession(req);
  if (address.toLowerCase() !== owner.toLowerCase()) throw new AppError("UNAUTHORIZED", "This action is only allowed for the signed-in wallet.", 403);
  return address;
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}
