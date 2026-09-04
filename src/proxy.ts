import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge proxy: compliance geoblock. Execution routes (quotes, trade plans, Earn call building) and
 *    anything that gives out or takes in a tokenized stock (gifts, gift pools) answer 451 for
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
/** Closed to a blocked region whatever the method: these routes exist only to build an execution. */
const RESTRICTED_API = [/^\/api\/trade\//, /^\/api\/earn\/prepare/, /^\/api\/portfolio\/(plan|quote|execute)/];

/**
 * Closed for writes only. Reading a gift receipt or the pool directory is browsing and stays open
 * everywhere; creating one, or asking BStocks to sign a ticket that authorises someone to receive a
 * share of one, is distribution of a tokenized security and is not.
 *
 * The claim transaction itself goes straight to the contract and no server can stop it — the
 * eligibility notice on the claim page is the gate there, as it is for gifts.
 */
const RESTRICTED_WRITES = [/^\/api\/pools/, /^\/api\/gifts/];

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
    const write = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
    if (RESTRICTED_API.some((r) => r.test(path)) || (write && RESTRICTED_WRITES.some((r) => r.test(path)))) {
      const country = requestCountry(req);
      if (country && blockedCountries().includes(country)) {
        const mode = geoblockMode();
        const attested = mode === "attest" && req.cookies.get(ELIGIBILITY_COOKIE)?.value === "confirmed";
        if (!attested) {
          return NextResponse.json(
            { error: { code: "REGION_RESTRICTED", message: "This is not available in your region. Coinbase Tokenized Stocks are only for eligible persons outside the United States.", details: { country, mode } } },
            { status: 451, headers: { "cache-control": "no-store" } },
          );
        }
      }
    }
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next|.well-known|icon.svg|logo.svg|favicon.ico).*)"],
};
