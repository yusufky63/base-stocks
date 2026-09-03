import { describe, expect, it } from "vitest";
import { raceWithFallback } from "./fallback";
import { AppError } from "./errors";

const delay = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const fail = (ms: number, e: unknown) => new Promise<never>((_, rej) => setTimeout(() => rej(e), ms));

describe("raceWithFallback", () => {
  it("returns the primary result when it is fast", async () => {
    const r = await raceWithFallback([() => delay(5, "primary"), () => delay(1, "fallback")], { hedgeDelayMs: 50 });
    expect(r).toBe("primary");
  });

  it("starts the fallback immediately when the primary fails before the hedge delay (no hang)", async () => {
    const started = Date.now();
    const r = await raceWithFallback([() => fail(5, new AppError("ROUTE_UNAVAILABLE", "bad input", 400)), () => delay(5, "fallback")], { hedgeDelayMs: 500 });
    expect(r).toBe("fallback");
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("hedges a slow primary and takes the first success", async () => {
    const r = await raceWithFallback([() => delay(300, "primary"), () => delay(10, "fallback")], { hedgeDelayMs: 20 });
    expect(r).toBe("fallback");
  });

  it("waits for the primary when the hedged fallback fails", async () => {
    const r = await raceWithFallback([() => delay(80, "primary"), () => fail(5, new Error("down"))], { hedgeDelayMs: 10 });
    expect(r).toBe("primary");
  });

  it("surfaces the most specific error when everything fails", async () => {
    await expect(
      raceWithFallback([() => fail(5, new AppError("PROVIDER_UNAVAILABLE", "0x down", 503)), () => fail(5, new AppError("AMOUNT_TOO_SMALL", "too small", 400))], { hedgeDelayMs: 10 }),
    ).rejects.toMatchObject({ code: "AMOUNT_TOO_SMALL" });
    await expect(raceWithFallback([() => fail(1, new Error("x")), () => fail(1, new Error("y"))], { hedgeDelayMs: 10 })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("chains through more than two providers", async () => {
    const r = await raceWithFallback([() => fail(1, new Error("a")), () => fail(1, new Error("b")), () => delay(1, "c")], { hedgeDelayMs: 10 });
    expect(r).toBe("c");
  });
});
