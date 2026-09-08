import { z } from "zod";
import { route, json, parseBody } from "@/lib/api";
import { regionState } from "@/lib/geo";

const COOKIE = "bstocks_eligibility";
const THIRTY_DAYS = 30 * 24 * 3600;

/** One definition of the rule, shared with the routes that enforce it. */
const describe = regionState;

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
export const POST = route({ rateLimit: { key: "region.attest", limit: 20, windowMs: 60_000, durable: true } }, async (req) => {
  const body = await parseBody(req, z.object({ confirm: z.boolean() }));
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const cookie = body.confirm ? `${COOKIE}=confirmed; Path=/; Max-Age=${THIRTY_DAYS}; SameSite=Lax; HttpOnly${secure}` : `${COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure}`;
  const state = describe(req);
  const attested = body.confirm;
  const res = json({ ...state, attested, restricted: state.blockedCountry && !(state.mode === "attest" && attested) });
  res.headers.append("set-cookie", cookie);
  return res;
});
