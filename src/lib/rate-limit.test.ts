import { afterEach, describe, expect, it, vi } from "vitest";
import { isSupabaseConfigured } from "@/db/supabase";
import { clientIp, enforceRateLimit, hashIp, windowKey } from "./rate-limit";

const request = (headers: Record<string, string> = {}) => new Request("https://basestocks.finance/api/x", { headers });

describe("client ip", () => {
  const saved = { vercel: process.env.VERCEL, proxy: process.env.TRUSTED_PROXY };
  afterEach(() => {
    if (saved.vercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = saved.vercel;
    if (saved.proxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = saved.proxy;
  });

  /** Off a trusted proxy the header is client text: honouring it lets one machine be a thousand addresses. */
  it("ignores x-forwarded-for unless a trusted proxy wrote it", () => {
    delete process.env.VERCEL;
    delete process.env.TRUSTED_PROXY;
    expect(clientIp(request({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe("local");
    expect(clientIp(request({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    process.env.TRUSTED_PROXY = "1";
    expect(clientIp(request({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe("1.2.3.4");
    delete process.env.TRUSTED_PROXY;
    process.env.VERCEL = "1";
    expect(clientIp(request({ "x-forwarded-for": " 5.6.7.8 " }))).toBe("5.6.7.8");
    expect(clientIp(request())).toBe("local");
  });

  it("hashes an ip to a short stable key and never stores the address", () => {
    expect(hashIp("1.2.3.4")).toHaveLength(16);
    expect(hashIp("1.2.3.4")).toBe(hashIp("1.2.3.4"));
    expect(hashIp("1.2.3.4")).not.toBe(hashIp("1.2.3.5"));
    expect(hashIp("1.2.3.4")).not.toContain("1.2.3.4");
  });
});

describe("window maths", () => {
  it("folds the window index into the key and dates the row by the day the sweep prunes on", () => {
    const t0 = Date.UTC(2026, 8, 13, 10, 0, 0);
    const a = windowKey("r", "h", 60_000, t0);
    const b = windowKey("r", "h", 60_000, t0 + 59_999);
    const c = windowKey("r", "h", 60_000, t0 + 60_000);
    expect(a.key).toBe(b.key);
    expect(c.key).not.toBe(a.key);
    expect(a.key).toMatch(/^rl:r:h:\d+$/);
    expect(a.day).toBe("2026-09-13");
    // A day-long window is one key for the whole day.
    expect(windowKey("reg", "h", 86_400_000, t0).key).toBe(windowKey("reg", "h", 86_400_000, t0 + 12 * 3600_000).key);
  });
});

describe.skipIf(isSupabaseConfigured())("memory bucket", () => {
  afterEach(() => vi.useRealTimers());

  it("lets `limit` through, refuses the next, and refills with time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T10:00:00Z"));
    process.env.TRUSTED_PROXY = "1";
    const req = request({ "x-forwarded-for": "7.7.7.7" });
    const opts = { limit: 3, windowMs: 60_000 };
    enforceRateLimit(req, "t.bucket", opts);
    enforceRateLimit(req, "t.bucket", opts);
    enforceRateLimit(req, "t.bucket", opts);
    expect(() => enforceRateLimit(req, "t.bucket", opts)).toThrow(/too many/i);
    // Another address has its own bucket.
    expect(() => enforceRateLimit(request({ "x-forwarded-for": "8.8.8.8" }), "t.bucket", opts)).not.toThrow();
    // A third of the window refills one token.
    vi.setSystemTime(Date.now() + 20_000);
    expect(() => enforceRateLimit(req, "t.bucket", opts)).not.toThrow();
    expect(() => enforceRateLimit(req, "t.bucket", opts)).toThrow(/too many/i);
    delete process.env.TRUSTED_PROXY;
  });
});
