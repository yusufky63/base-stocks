import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge proxy with two jobs:
 * 1. Referral capture: `?ref=<address>` on any page is stored in an HttpOnly cookie for 30 days and
 *    linked to the wallet on its first sign-in (see /api/auth/verify). The query param is stripped.
 * 2. Compliance geoblock: execution routes (quotes, trade plans, Earn call building) answer 451 for
 *    countries in GEOBLOCK_COUNTRIES (default "US"). Coinbase Tokenized Stocks are only for eligible
 *    persons outside the United States, and 0x's tokenized-equities opt-in makes the integrator
 *    responsible for geoblocking. Browsing, prices and news stay open everywhere. The country comes
 *    from the hosting provider's header; when no header is present nothing is blocked (no guessing).
 *    GEOBLOCK_MODE=attest (default) lets a visitor from a blocked country self-certify eligibility
 *    (cookie set by POST /api/region, 30 days); GEOBLOCK_MODE=block is the hard version.
 */
export const ELIGIBILITY_COOKIE = "bstocks_eligibility";

function geoblockMode(): "block" | "attest" {
  return process.env.GEOBLOCK_MODE === "block" ? "block" : "attest";
}
const RESTRICTED_API = [/^\/api\/trade\//, /^\/api\/earn\/prepare/, /^\/api\/portfolio\/(plan|quote|execute)/];

function blockedCountries(): string[] {
  return (process.env.GEOBLOCK_COUNTRIES ?? "US")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

function requestCountry(req: NextRequest): string {
  return (req.headers.get("x-vercel-ip-country") ?? req.headers.get("cf-ipcountry") ?? req.headers.get("x-country-code") ?? "").toUpperCase();
}

export function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;

  if (path.startsWith("/api/")) {
    if (RESTRICTED_API.some((r) => r.test(path))) {
      const country = requestCountry(req);
      if (country && blockedCountries().includes(country)) {
        const mode = geoblockMode();
        const attested = mode === "attest" && req.cookies.get(ELIGIBILITY_COOKIE)?.value === "confirmed";
        if (!attested) {
          return NextResponse.json(
            { error: { code: "REGION_RESTRICTED", message: "Trading and Earn are not available in your region. Coinbase Tokenized Stocks are only for eligible persons outside the United States.", details: { country, mode } } },
            { status: 451, headers: { "cache-control": "no-store" } },
          );
        }
      }
    }
    return NextResponse.next();
  }

  const ref = req.nextUrl.searchParams.get("ref");
  if (!ref || !/^0x[0-9a-fA-F]{40}$/.test(ref)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.searchParams.delete("ref");
  const res = NextResponse.redirect(url);
  res.cookies.set("bstocks_ref", ref, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600, secure: process.env.NODE_ENV === "production" });
  return res;
}

export const config = {
  matcher: ["/((?!_next|.well-known|icon.svg|logo.svg|favicon.ico).*)"],
};
