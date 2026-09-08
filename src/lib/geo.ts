import { serverEnv } from "@/config/env";
import { AppError } from "@/lib/errors";

/**
 * Country of the incoming request as the hosting layer reports it (Vercel, Cloudflare, or the
 * plain header used in tests). Uppercase ISO code, or null when no edge added one (local dev).
 * Shared by the region endpoint and per-provider gates so every gate agrees on the answer.
 */
export function requestCountry(req: Request): string | null {
  const country = (req.headers.get("x-vercel-ip-country") ?? req.headers.get("cf-ipcountry") ?? req.headers.get("x-country-code") ?? "").toUpperCase();
  return country || null;
}

/**
 * Where Coinbase Tokenized Stocks may not be traded, and what the app does about it.
 *
 * The issuer offers these assets only to eligible persons outside the United States, so a
 * restricted visitor must not be handed anything they could sign. The default is `block`: refuse
 * outright. `attest` is the softer mode, where a visitor self-certifies eligibility and the cookie
 * that records it unlocks the same routes; it exists for deployments that want it and has to be
 * turned on deliberately, because "enabling trading for US users" is exactly what the default must
 * not do.
 */
export function geoPolicy(): { blocked: string[]; mode: "block" | "attest" } {
  const env = serverEnv();
  const blocked = (env.GEOBLOCK_COUNTRIES ?? "US")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  return { blocked, mode: env.GEOBLOCK_MODE === "attest" ? "attest" : "block" };
}

const ATTESTED = /(?:^|;\s*)bstocks_eligibility=confirmed(?:;|$)/;

/** The visitor's standing: where they are, and whether execution routes may answer them. */
export function regionState(req: Request): { country: string | null; blocked: string[]; mode: "block" | "attest"; blockedCountry: boolean; attested: boolean; restricted: boolean } {
  const country = requestCountry(req);
  const { blocked, mode } = geoPolicy();
  const attested = ATTESTED.test(req.headers.get("cookie") ?? "");
  const blockedCountry = !!country && blocked.includes(country);
  return { country, blocked, mode, blockedCountry, attested, restricted: blockedCountry && !(mode === "attest" && attested) };
}

/**
 * Refuse anything a restricted visitor could act on.
 *
 * Called by every route that returns calldata, a signable order or a prepared transaction. Reads
 * stay open: prices, charts, news and Earn data are public information, and hiding them would
 * serve nobody. Enforcement lives here rather than in the browser because a notice a client can
 * ignore is not a restriction.
 */
export function assertTradingAllowed(req: Request): void {
  const state = regionState(req);
  if (!state.restricted) return;
  throw new AppError(
    "REGION_BLOCKED",
    "Coinbase Tokenized Stocks are offered only to eligible persons outside the United States, so orders and deposits cannot be placed from your location. Prices, charts and news stay open.",
    451,
    { country: state.country },
  );
}
