import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { basketSignature, MAX_RECENT, parseStore, remember, type SavedBasket } from "./recent-baskets";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const MSFT = "0xB200000000000000000000Ab99cFa739E253872B" as Address;
const mix = (a: number, b: number) => [
  { assetAddress: NVDA, weightBps: a },
  { assetAddress: MSFT, weightBps: b },
];

describe("what counts as the same basket", () => {
  it("ignores order and letter case, not weights", () => {
    expect(basketSignature(mix(6000, 4000))).toBe(basketSignature([...mix(6000, 4000)].reverse()));
    expect(basketSignature([{ assetAddress: NVDA.toLowerCase() as Address, weightBps: 6000 }])).toBe(basketSignature([{ assetAddress: NVDA, weightBps: 6000 }]));
    expect(basketSignature(mix(6000, 4000))).not.toBe(basketSignature(mix(5000, 5000)));
  });
});

describe("remembering baskets", () => {
  it("puts the newest first and moves a repeated mix to the top under its new name", () => {
    let list = remember([], { name: "First", allocations: mix(6000, 4000), source: "custom" }, 1_000);
    list = remember(list, { name: "Second", allocations: mix(5000, 5000), source: "ai" }, 2_000);
    list = remember(list, { name: "First again", allocations: mix(6000, 4000), source: "custom" }, 3_000);
    expect(list.map((b) => b.name)).toEqual(["First again", "Second"]);
    expect(list[0]!.savedAt).toBe(3_000);
  });

  it("keeps at most the cap, dropping the oldest", () => {
    let list: SavedBasket[] = [];
    for (let i = 0; i < MAX_RECENT + 3; i++) list = remember(list, { name: `b${i}`, allocations: mix(10_000 - i, i), source: "custom" }, i);
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0]!.name).toBe(`b${MAX_RECENT + 2}`);
  });

  it("does not record an empty basket", () => {
    expect(remember([], { name: "Nothing", allocations: [], source: "custom" })).toEqual([]);
  });
});

describe("reading the store back", () => {
  it("drops entries that do not look like baskets and an empty draft", () => {
    const good: SavedBasket = { id: "x", name: "Good", allocations: mix(5000, 5000), source: "ai", savedAt: 1 };
    const raw = JSON.stringify({ draft: { ...good, allocations: [] }, recent: [good, { id: 1 }, { ...good, source: "community" }] });
    const store = parseStore(raw);
    expect(store.draft).toBeNull();
    expect(store.recent).toEqual([good]);
  });

  it("treats garbage and nothing as an empty store", () => {
    expect(parseStore("{not json")).toEqual({ draft: null, recent: [] });
    expect(parseStore(null)).toEqual({ draft: null, recent: [] });
  });
});
