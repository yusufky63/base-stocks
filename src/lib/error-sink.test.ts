import { afterEach, describe, expect, it, vi } from "vitest";
import { isSupabaseConfigured } from "@/db/supabase";
import { clearErrors, fingerprintOf, recentErrors, recordError } from "./error-sink";

/** These exercise the in-memory view; with Supabase configured the same calls would hit the network. */
describe.skipIf(isSupabaseConfigured())("error sink", () => {
  it("buckets the same failure with different numbers into one fingerprint", () => {
    const a = fingerprintOf({ source: "route", route: "/api/trade", message: "quote failed after 1234 ms for 0xabcdef0123456789" });
    const b = fingerprintOf({ source: "route", route: "/api/trade", message: "quote failed after 5678 ms for 0x9876543210fedcba" });
    const other = fingerprintOf({ source: "route", route: "/api/earn", message: "quote failed after 1234 ms for 0xabcdef0123456789" });
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });

  afterEach(() => vi.useRealTimers());

  it("counts occurrences on one row and answers a window", async () => {
    await clearErrors();
    await recordError({ source: "route", route: "/t/count", message: "upstream said no" });
    await recordError({ source: "route", route: "/t/count", message: "upstream said no" });
    const rows = await recentErrors(10, 60_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(2);
    // Ten minutes on, the hour still holds it and the minute has let it go: the alarm can turn itself off.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect(await recentErrors(10, 3600_000)).toHaveLength(1);
    expect(await recentErrors(10, 60_000)).toHaveLength(0);
  });

  it("clears one fingerprint and leaves the rest", async () => {
    await clearErrors();
    await recordError({ source: "client", route: "/t/a", message: "first" });
    await recordError({ source: "client", route: "/t/b", message: "second" });
    const target = fingerprintOf({ source: "client", route: "/t/a", message: "first" });
    await clearErrors({ fingerprint: target });
    const left = await recentErrors(10, 60_000);
    expect(left.map((e) => e.route)).toEqual(["/t/b"]);
  });

  it("clears everything when asked for no fingerprint and no cutoff", async () => {
    await recordError({ source: "server", route: "/t/all", message: "boom" });
    await clearErrors();
    expect(await recentErrors(10, 60_000)).toHaveLength(0);
  });
});
