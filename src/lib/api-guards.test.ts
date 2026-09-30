import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The guards every route shares: the same-origin check `route()` runs before any handler, the
 * constant-time secret comparison, and the bearer check on scheduled routes.
 */
const h = vi.hoisted(() => ({ publicEnv: { appUrl: "https://basestocks.finance" }, recordError: vi.fn() }));

vi.mock("@/config/public-env", () => ({ publicEnv: h.publicEnv }));
vi.mock("@/lib/error-sink", () => ({ recordError: h.recordError }));
vi.mock("@/lib/rate-limit", () => ({ enforceRateLimit: vi.fn(), enforceDurableRateLimit: vi.fn() }));

import { AppError } from "@/lib/errors";
import { requireAdmin, requireCron, route, secretEquals } from "./api";

const handler = vi.fn(async () => new Response("ok"));
const guarded = route({}, handler);

function send(method: string, origin: string | null, opts: { url?: string; forwardedHost?: string } = {}): Promise<Response> {
  const headers = new Headers();
  if (origin !== null) headers.set("origin", origin);
  if (opts.forwardedHost) headers.set("x-forwarded-host", opts.forwardedHost);
  return guarded(new Request(opts.url ?? "https://basestocks.finance/api/trades", { method, headers }), {});
}

async function refused(res: Response) {
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ error: { code: "UNAUTHORIZED", message: "Cross-site request refused." } });
}

beforeEach(() => {
  handler.mockClear();
  h.recordError.mockReset();
  h.publicEnv.appUrl = "https://basestocks.finance";
});

describe("route(): same-origin writes", () => {
  it("accepts a write from the request's own host", async () => {
    expect((await send("POST", "https://basestocks.finance")).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("accepts the configured app URL's host when the request arrives under another name", async () => {
    expect((await send("POST", "https://basestocks.finance", { url: "http://10.0.0.7:3000/api/trades" })).status).toBe(200);
  });

  it("accepts the first x-forwarded-host a proxy names", async () => {
    h.publicEnv.appUrl = "";
    expect((await send("POST", "https://preview.example", { url: "http://10.0.0.7:3000/api/trades", forwardedHost: "preview.example, internal.proxy" })).status).toBe(200);
    await refused(await send("POST", "https://internal.proxy", { url: "http://10.0.0.7:3000/api/trades", forwardedHost: "preview.example, internal.proxy" }));
  });

  it("accepts localhost on any port, for development", async () => {
    expect((await send("POST", "http://localhost:3000")).status).toBe(200);
    expect((await send("POST", "http://localhost")).status).toBe(200);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("refuses a foreign %s before the handler runs", async (method) => {
    await refused(await send(method, "https://evil.example"));
    expect(handler).not.toHaveBeenCalled();
    // A refusal is an expected 4xx, not an incident.
    expect(h.recordError).not.toHaveBeenCalled();
  });

  it.each([
    ["a suffix of the app's host", "https://basestocks.finance.evil.example"],
    ["a longer name ending in it", "https://evilbasestocks.finance"],
    ["the app's host on another port", "https://basestocks.finance:8443"],
    ["a name starting with localhost", "http://localhost.evil.example"],
    ["userinfo that looks like localhost", "http://localhost:3000@evil.example"],
  ])("refuses a look-alike origin: %s", async (_label, origin) => {
    await refused(await send("POST", origin));
  });

  it("refuses an opaque `Origin: null` (sandboxed frames, data: URLs)", async () => {
    await refused(await send("POST", "null"));
  });

  it("still refuses foreign origins when the app URL is unset or malformed", async () => {
    h.publicEnv.appUrl = "not a url";
    await refused(await send("POST", "https://evil.example"));
    expect((await send("POST", "https://basestocks.finance")).status).toBe(200);
  });

  it("leaves a request without an Origin header to its bearer or session (cron, bots, curl)", async () => {
    expect((await send("POST", null)).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each(["GET", "HEAD", "OPTIONS"])("does not guard a %s, which cannot write", async (method) => {
    expect((await send(method, "https://evil.example")).status).toBe(200);
  });

  // Known bug: `host.endsWith(".vercel.app")` (src/lib/api.ts:61) accepts every Vercel deployment,
  // not only this project's previews, so a page hosted at attacker.vercel.app can post with the
  // visitor's SameSite=None session. Remove `.fails` once the check is limited to this project.
  it.fails("refuses a *.vercel.app origin that is not one of this project's deployments", async () => {
    await refused(await send("POST", "https://attacker-page.vercel.app"));
  });

  it("maps a handler's unexpected error to a 500 and records it", async () => {
    const failing = route({}, async () => {
      throw new Error("boom");
    });
    const res = await failing(new Request("https://basestocks.finance/api/x", { method: "POST" }), {});
    expect(res.status).toBe(500);
    expect(h.recordError).toHaveBeenCalledWith(expect.objectContaining({ source: "route", route: "/api/x", message: "boom" }));
  });
});

describe("secretEquals", () => {
  it("is true only for identical secrets", () => {
    expect(secretEquals("s3cret-value-0123", "s3cret-value-0123")).toBe(true);
    expect(secretEquals("s3cret-value-0123", "s3cret-value-0124")).toBe(false);
  });

  it("answers a length mismatch with false instead of throwing", () => {
    expect(secretEquals("short", "a-much-longer-secret")).toBe(false);
    expect(secretEquals("a-much-longer-secret", "short")).toBe(false);
    expect(secretEquals("s3cret", "s3cret ")).toBe(false);
  });

  it("never matches an absent or empty secret, not even another empty one", () => {
    expect(secretEquals("", "")).toBe(false);
    expect(secretEquals(null, null)).toBe(false);
    expect(secretEquals(undefined, "x")).toBe(false);
    expect(secretEquals("x", null)).toBe(false);
  });

  it("compares bytes, so characters of different widths do not collide", () => {
    expect(secretEquals("é", "ab")).toBe(false); // both two bytes in UTF-8
    expect(secretEquals("é", "é")).toBe(true);
  });
});

describe("requireCron", () => {
  const SECRET = "cron-secret-0123456789";
  const req = (authorization?: string) => new Request("https://basestocks.finance/api/cron/automation", { headers: authorization === undefined ? {} : { authorization } });
  const status = (fn: () => void): number | null => {
    try {
      fn();
      return null;
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("UNAUTHORIZED");
      return (err as AppError).httpStatus;
    }
  };

  it("passes the right bearer, with surrounding spaces trimmed", () => {
    expect(status(() => requireCron(req(`Bearer ${SECRET}`), SECRET))).toBeNull();
    expect(status(() => requireCron(req(`Bearer   ${SECRET}  `), SECRET))).toBeNull();
  });

  it.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["a wrong bearer", "Bearer cron-secret-0123456780"],
    ["the secret without a scheme", SECRET],
    ["another scheme", `Basic ${SECRET}`],
    ["a lower-case scheme", `bearer ${SECRET}`],
    ["an empty bearer", "Bearer "],
  ])("refuses %s with 401", (_label, header) => {
    expect(status(() => requireCron(req(header), SECRET))).toBe(401);
  });

  it("refuses everything while no secret is configured", () => {
    expect(status(() => requireCron(req("Bearer "), undefined))).toBe(401);
    expect(status(() => requireCron(req("Bearer undefined"), undefined))).toBe(401);
    expect(status(() => requireCron(req("Bearer "), ""))).toBe(401);
  });
});

describe("requireAdmin", () => {
  const TOKEN = "admin-token-0123456789";
  const req = (token?: string) => new Request("https://basestocks.finance/api/admin/overview", { headers: token === undefined ? {} : { "x-admin-token": token } });

  it("passes the configured token and refuses anything else", () => {
    expect(() => requireAdmin(req(TOKEN), TOKEN)).not.toThrow();
    expect(() => requireAdmin(req("admin-token-0123456780"), TOKEN)).toThrow(AppError);
    expect(() => requireAdmin(req(), TOKEN)).toThrow(AppError);
  });

  it("refuses everything while no token is configured", () => {
    expect(() => requireAdmin(req(""), undefined)).toThrow(AppError);
    expect(() => requireAdmin(req("anything"), undefined)).toThrow(AppError);
  });
});
