import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The session cookie is the app's only proof of wallet ownership after the SIWE signature, so the
 * round trip, the expiry and the tamper checks are pinned here. The secret is set before the
 * module loads: the module caches it on first use.
 */
const ADDRESS = "0x1111111111111111111111111111111111111111" as const;
let session: typeof import("./session");

beforeAll(async () => {
  process.env.AUTH_SECRET = "test-secret-that-is-long-enough";
  session = await import("./session");
});

afterEach(() => vi.useRealTimers());

const request = (cookie?: string) => new Request("https://basestocks.finance/api/x", { headers: cookie ? { cookie } : {} });

describe("session cookie", () => {
  it("round-trips an address with a normalised (checksummed) form", () => {
    const token = session.encodeSession(ADDRESS);
    const decoded = session.decodeSession(token);
    expect(decoded?.address.toLowerCase()).toBe(ADDRESS);
    expect(decoded?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T00:00:00Z"));
    const token = session.encodeSession(ADDRESS, 60);
    expect(session.decodeSession(token)).not.toBeNull();
    vi.setSystemTime(new Date("2026-09-13T00:01:01Z"));
    expect(session.decodeSession(token)).toBeNull();
  });

  it("refuses a tampered payload, a tampered signature and garbage", () => {
    const token = session.encodeSession(ADDRESS);
    const [payload, sig] = token.split(".") as [string, string];
    const other = Buffer.from(JSON.stringify({ address: "0x2222222222222222222222222222222222222222", exp: Math.floor(Date.now() / 1000) + 3600 }), "utf8").toString("base64url");
    expect(session.decodeSession(`${other}.${sig}`)).toBeNull();
    expect(session.decodeSession(`${payload}.${sig.slice(0, -2)}xx`)).toBeNull();
    expect(session.decodeSession(`${payload}.`)).toBeNull();
    expect(session.decodeSession("not-a-token")).toBeNull();
    expect(session.decodeSession("")).toBeNull();
    expect(session.decodeSession(null)).toBeNull();
  });

  it("reads the session from the cookie header and ignores the other cookies", () => {
    const token = session.encodeSession(ADDRESS);
    const req = request(`theme=dark; ${session.SESSION_COOKIE}=${encodeURIComponent(token)}; other=1`);
    expect(session.sessionAddress(req)?.toLowerCase()).toBe(ADDRESS);
    expect(session.sessionAddress(request())).toBeNull();
    expect(() => session.requireSession(request())).toThrow(/sign in/i);
  });

  /** A stray `%` in a cookie used to throw out of decodeURIComponent and answer the request with a 500. */
  it("treats a malformed cookie as absent rather than failing the request", () => {
    expect(session.readCookie(request(`${session.SESSION_COOKIE}=%E0%A4%A`), session.SESSION_COOKIE)).toBeNull();
    expect(session.sessionAddress(request(`${session.SESSION_COOKIE}=%ZZ`))).toBeNull();
  });

  it("requireOwner accepts only the signed-in wallet", () => {
    const token = session.encodeSession(ADDRESS);
    const req = request(`${session.SESSION_COOKIE}=${token}`);
    expect(session.requireOwner(req, ADDRESS).toLowerCase()).toBe(ADDRESS);
    expect(() => session.requireOwner(req, "0x2222222222222222222222222222222222222222")).toThrow(/signed-in wallet/i);
  });

  it("writes cookies with the attributes the embed needs in production only", () => {
    const header = session.cookieHeader("c", "v v", 60);
    expect(header).toMatch(/^c=v%20v; Path=\/; Max-Age=60; HttpOnly; SameSite=/);
    expect(session.clearCookieHeader("c")).toMatch(/^c=; Path=\/; Max-Age=0/);
  });
});
