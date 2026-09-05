import { describe, expect, it } from "vitest";
import { decode, encode } from "./codec";

describe("values shared between server instances", () => {
  it("round-trips bigints, Maps and Sets exactly", () => {
    const value = {
      supply: 123456789012345678901234567890n,
      prices: new Map([["0xabc", { usd: 1.5, raw: 42n }]]),
      reserves: new Set(["0x1", "0x2"]),
      nested: [{ m: new Map([[1, 2n]]) }],
      plain: { s: "text", n: 1, b: false, nil: null },
    };
    const back = decode<typeof value>(encode(value));
    expect(back.supply).toBe(value.supply);
    expect(back.prices.get("0xabc")).toEqual({ usd: 1.5, raw: 42n });
    expect(back.reserves.has("0x2")).toBe(true);
    expect(back.nested[0]!.m.get(1)).toBe(2n);
    expect(back.plain).toEqual(value.plain);
  });

  it("leaves objects that merely look like tags alone", () => {
    const value = { $bigint: "1", other: 2 };
    expect(decode(encode(value))).toEqual(value);
  });

  it("is plain JSON for plain values", () => {
    expect(encode({ a: [1, "x", null] })).toBe('{"a":[1,"x",null]}');
  });
});
