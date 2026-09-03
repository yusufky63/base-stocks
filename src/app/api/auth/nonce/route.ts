import { route } from "@/lib/api";
import { cookieHeader, newNonce, NONCE_COOKIE } from "@/lib/auth/session";

/** Issue a one-time SIWE nonce (stored in an HttpOnly cookie, 10 minutes). */
export const GET = route({ rateLimit: { key: "auth.nonce", limit: 30, windowMs: 60_000 } }, async () => {
  const nonce = newNonce();
  return new Response(JSON.stringify({ nonce }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": cookieHeader(NONCE_COOKIE, nonce, 600) },
  });
});
