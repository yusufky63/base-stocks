import { z } from "zod";
import { route, json, parseBody } from "@/lib/api";
import { serverEnv } from "@/config/env";

const COOKIE = "bstocks_eligibility";
const THIRTY_DAYS = 30 * 24 * 3600;

function describe(req: Request) {
  const country = (req.headers.get("x-vercel-ip-country") ?? req.headers.get("cf-ipcountry") ?? req.headers.get("x-country-code") ?? "").toUpperCase();
  const env = serverEnv();
  const blocked = (env.GEOBLOCK_COUNTRIES ?? "US")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  const mode: "block" | "attest" = env.GEOBLOCK_MODE === "block" ? "block" : "attest";
  const attested = /(?:^|;\s*)bstocks_eligibility=confirmed(?:;|$)/.test(req.headers.get("cookie") ?? "");
  const blockedCountry = !!country && blocked.includes(country);
  return { country: country || null, blocked, mode, blockedCountry, attested, restricted: blockedCountry && !(mode === "attest" && attested) };
}

/**
 * The visitor's region as the hosting provider reports it and whether execution routes are blocked
 * for it (same rule as the proxy). Never cached: the answer is per request.
 */
export const GET = route({}, async (req) => json(describe(req)));

/**
 * Self-certification for GEOBLOCK_MODE=attest: the visitor confirms they are not a US person and are
 * eligible under the issuer's terms. Stored as an HttpOnly cookie on this device for 30 days; nothing
 * about the person is recorded. `confirm: false` withdraws it.
 */
export const POST = route({ rateLimit: { key: "region.attest", limit: 20, windowMs: 60_000 } }, async (req) => {
  const body = await parseBody(req, z.object({ confirm: z.boolean() }));
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const cookie = body.confirm ? `${COOKIE}=confirmed; Path=/; Max-Age=${THIRTY_DAYS}; SameSite=Lax; HttpOnly${secure}` : `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure}`;
  const state = describe(req);
  const attested = body.confirm;
  const res = json({ ...state, attested, restricted: state.blockedCountry && !(state.mode === "attest" && attested) });
  res.headers.append("set-cookie", cookie);
  return res;
});
