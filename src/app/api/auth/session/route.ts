import { route } from "@/lib/api";
import { clearCookieHeader, sessionAddress, SESSION_COOKIE } from "@/lib/auth/session";

export const GET = route({}, async (req) => {
  const address = sessionAddress(req);
  return new Response(JSON.stringify({ address }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
});

/** Sign out. */
export const DELETE = route({}, async () => {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "set-cookie": clearCookieHeader(SESSION_COOKIE) } });
});
