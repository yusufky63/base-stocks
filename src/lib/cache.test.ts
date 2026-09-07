import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cached, invalidate } from "./cache";
import { setSharedStore, type SharedEntry, type SharedStore } from "./shared-store";
import { encode } from "./codec";

class FakeStore implements SharedStore {
  readonly name = "fake";
  readonly items = new Map<string, SharedEntry>();
  reads = 0;
  writes = 0;
  async get(key: string) {
    this.reads += 1;
    return this.items.get(key) ?? null;
  }
  async set(key: string, entry: SharedEntry) {
    this.writes += 1;
    this.items.set(key, entry);
  }
  async dropPrefix(prefix: string) {
    let n = 0;
    for (const k of [...this.items.keys()]) if (k.startsWith(prefix)) { this.items.delete(k); n += 1; }
    return n;
  }
  async sweep() {
    return 0;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("the shared tier under cached()", () => {
  let fake: FakeStore;
  beforeEach(() => {
    fake = new FakeStore();
    setSharedStore(fake);
    invalidate("");
  });
  afterEach(() => setSharedStore(undefined));

  /** The point of the tier: what one instance computed, the next one reads instead of recomputing. */
  it("serves a value another instance already computed, without running the loader", async () => {
    fake.items.set("k", { value: encode({ price: 1n }), expiresAt: Date.now() + 10_000, staleUntil: Date.now() + 60_000 });
    let loads = 0;
    const v = await cached<{ price: bigint }>("k", { ttlMs: 10_000, shared: true }, async () => {
      loads += 1;
      return { price: 2n };
    });
    expect(v.price).toBe(1n);
    expect(loads).toBe(0);
    expect(fake.reads).toBe(1);
  });

  it("computes on a shared miss and publishes for the others", async () => {
    const v = await cached("k2", { ttlMs: 10_000, shared: true }, async () => ({ n: 7 }));
    await tick();
    expect(v).toEqual({ n: 7 });
    expect(fake.writes).toBe(1);
    expect(fake.items.get("k2")!.value).toBe('{"n":7}');
  });

  it("never touches the shared store for a memory hit or a memory-only key", async () => {
    await cached("k3", { ttlMs: 10_000, shared: true }, async () => 1);
    await cached("k3", { ttlMs: 10_000, shared: true }, async () => 2);
    expect(fake.reads).toBe(1);
    await cached("k4", { ttlMs: 10_000 }, async () => 3);
    await tick();
    expect(fake.reads).toBe(1);
    expect(fake.writes).toBe(1);
  });

  /** A stale shared value is still an answer; the refresh happens behind it, not in front of the reader. */
  it("serves a stale shared value at once and refreshes in the background", async () => {
    fake.items.set("k5", { value: encode("old"), expiresAt: Date.now() - 1, staleUntil: Date.now() + 60_000 });
    let loads = 0;
    const v = await cached("k5", { ttlMs: 10_000, staleMs: 60_000, shared: true }, async () => {
      loads += 1;
      return "new";
    });
    expect(v).toBe("old");
    await tick();
    expect(loads).toBe(1);
    expect(await cached("k5", { ttlMs: 10_000, shared: true }, async () => "newer")).toBe("new");
  });

  it("keeps a partial result only briefly, so the next reader retries the provider that failed", async () => {
    let loads = 0;
    const opts = {
      ttlMs: 600_000,
      staleMs: 600_000,
      isPartial: (v: unknown) => (v as { missing: string[] }).missing.length > 0,
      partialTtlMs: -1, // already expired: the assertion is about the window, not about waiting
    };
    const partial = () => cached("p1", opts, async () => ({ missing: ["uniswap"], count: ++loads }));
    await partial();
    await partial();
    // Two calls, two loads — a partial answer never became the answer for the next ten minutes.
    expect(loads).toBe(2);
  });

  it("caches a complete result for the full window", async () => {
    let loads = 0;
    const opts = { ttlMs: 600_000, isPartial: (v: unknown) => (v as { missing: string[] }).missing.length > 0, partialTtlMs: -1 };
    const complete = () => cached("p2", opts, async () => ({ missing: [] as string[], count: ++loads }));
    await complete();
    await complete();
    expect(loads).toBe(1);
  });

  it("clears the shared tier too, so a refresh actually refreshes", async () => {
    const fake = new FakeStore();
    setSharedStore(fake);
    let loads = 0;
    const load = () => cached("earn:usdc", { ttlMs: 600_000, shared: true }, async () => `run-${++loads}`);
    expect(await load()).toBe("run-1");
    await invalidate("earn:");
    // Local only would have left run-1 in the shared store for the next read to pull straight back.
    expect(await load()).toBe("run-2");
    expect(fake.items.size).toBe(1);
  });

  it("treats a shared tier that will not answer as a re-scan, not an error", async () => {
    setSharedStore({ name: "broken", get: async () => null, set: async () => {}, sweep: async () => 0, dropPrefix: async () => { throw new Error("down"); } });
    await expect(invalidate("earn:")).resolves.toBeUndefined();
  });

  it("falls back to the loader when the shared store fails", async () => {
    setSharedStore({ name: "broken", get: async () => { throw new Error("down"); }, set: async () => { throw new Error("down"); }, sweep: async () => 0, dropPrefix: async () => { throw new Error("down"); } });
    expect(await cached("k6", { ttlMs: 1_000, shared: true }, async () => "computed")).toBe("computed");
  });
});
