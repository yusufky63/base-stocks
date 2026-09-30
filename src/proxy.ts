import { NextResponse, type NextRequest } from "next/server";
import { V1_CORS } from "@/lib/api-v1/respond";
import { headerAttested } from "@/lib/eligibility-store";

/**
 * Edge proxy: compliance geoblock. Execution routes (quotes, trade plans, Earn call building) and
 *    anything that gives out or takes in a tokenized stock (gifts, gift pools) answer 451 for
 *    countries in GEOBLOCK_COUNTRIES (default "US"). Coinbase Tokenized Stocks are only for eligible
 *    persons outside the United States, and 0x's tokenized-equities opt-in makes the integrator
 *    responsible for geoblocking. Browsing, prices and news stay open everywhere. The country comes
 *    from the hosting provider's header; when no header is present nothing is blocked (no guessing).
 *    GEOBLOCK_MODE=attest (default) asks: a visitor who confirms they are not a US person
 *    (cookie set by POST /api/region, 30 days) may continue even from a blocked country's IP.
 *    GEOBLOCK_MODE=block refuses outright.
 */
export const ELIGIBILITY_COOKIE = "bstocks_eligibility";

/**
 * `attest` is the default, and `block` has to be asked for.
 *
 * An IP address says where a connection comes from, not who is behind it: a non-US person
 * travelling or on a US-hosted VPN looks the same as a US resident. So a blocked country is asked
 * the eligibility question rather than refused, and the answer is the visitor's own statement.
 * `block` remains for a deployment that must refuse whatever the visitor says.
 */
function geoblockMode(): "block" | "attest" {
  return process.env.GEOBLOCK_MODE === "block" ? "block" : "attest";
}
/**
 * Closed to a blocked region whatever the method: these routes exist only to build an execution.
 * The list mirrors the handlers that call `assertTradingAllowed` (grep for it): trade quotes and
 * signed orders, the public trade builder, Earn deposits, the basket plan and the AI basket draft,
 * and the owner-side run of an AutoInvest plan. `/api/portfolio/quote` and `/execute` were listed
 * here for a while and never existed; a pattern that matches nothing protects nothing.
 */
const RESTRICTED_API = [/^\/api\/trade\//, /^\/api\/v1\/trade\/?$/, /^\/api\/earn\/prepare/, /^\/api\/portfolio\/(plan|intent)/, /^\/api\/automation\/prepare-run/];

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
    // The public API is called from other sites' browsers. A preflight builds nothing, and a
    // refused one would hide the 451 below behind a CORS error the caller cannot read.
    const publicApi = path.startsWith("/api/v1/");
    if (publicApi && req.method === "OPTIONS") return NextResponse.next();
    const write = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
    if (RESTRICTED_API.some((r) => r.test(path)) || (write && RESTRICTED_WRITES.some((r) => r.test(path)))) {
      const country = requestCountry(req);
      if (country && blockedCountries().includes(country)) {
        const mode = geoblockMode();
        // The cookie, or the same answer as a header from a widget whose frame could not keep it.
        const attested = mode === "attest" && (req.cookies.get(ELIGIBILITY_COOKIE)?.value === "confirmed" || headerAttested(req.headers));
        if (!attested) {
          // In `attest` a blocked region is not banned, it is asked, and the wording has to say so
          // or a 451 that a checkbox clears reads like a wall. In `block`, the default, there is
          // genuinely nothing the visitor can do.
          const message =
            mode === "attest"
              ? "Confirm your eligibility to continue. Coinbase Tokenized Stocks are offered only to eligible persons outside the United States."
              : "This is not available in your region. Coinbase Tokenized Stocks are offered only to eligible persons outside the United States.";
          return NextResponse.json(
            { error: { code: "REGION_RESTRICTED", message, details: { country, mode } } },
            { status: 451, headers: { "cache-control": "no-store", ...(publicApi ? V1_CORS : {}) } },
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
