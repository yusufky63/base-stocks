/**
 * The visitor's eligibility answer as this browser keeps it, next to the cookie the server sets.
 *
 * A widget runs inside another site's iframe, and a browser may refuse that frame a cookie (Safari
 * does by default). Kept here too, the answer goes along as a header on every request to our own
 * API (lib/client-api.ts), so a visitor who confirmed is never refused because their browser dropped
 * the cookie. Storage can be refused as well, so a copy lives in memory for the life of the page.
 * The server treats the header exactly as it treats the cookie (lib/geo.ts, proxy.ts): both are the
 * visitor's own statement.
 */
export const ELIGIBILITY_HEADER = "x-bstocks-eligibility";

const STORAGE_KEY = "bstocks:eligibility";
const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

let memoryUntil = 0;

function readUntil(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const until = raw ? Number(raw) : 0;
    if (Number.isFinite(until) && until > memoryUntil) memoryUntil = until;
  } catch {
    /* storage refused: memory is all there is */
  }
  return memoryUntil;
}

export function storedAttestation(now = Date.now()): boolean {
  if (typeof window === "undefined") return false;
  return readUntil() > now;
}

export function storeAttestation(confirm: boolean, now = Date.now()): void {
  if (typeof window === "undefined") return;
  memoryUntil = confirm ? now + THIRTY_DAYS_MS : 0;
  try {
    if (confirm) window.localStorage.setItem(STORAGE_KEY, String(memoryUntil));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage refused */
  }
}

/** Headers for a request to our own API: the answer, when this browser has one. */
export function eligibilityHeaders(): Record<string, string> {
  return storedAttestation() ? { [ELIGIBILITY_HEADER]: "confirmed" } : {};
}

/** Whether a request carries the answer as the header. Used by the server alongside the cookie. */
export function headerAttested(headers: Headers): boolean {
  return headers.get(ELIGIBILITY_HEADER)?.trim() === "confirmed";
}
