import { describe, expect, it } from "vitest";
import { looksLikeBasename, normalizeAddress, tryNormalizeAddress, isSameAddress, isB20PrecompileAddress } from "./address";

describe("address helpers", () => {
  it("checksums valid addresses and rejects invalid ones", () => {
    expect(normalizeAddress("0xb20000000000000000000078ee7ce2fe4908108c")).toBe("0xb20000000000000000000078ee7ce2fE4908108C");
    expect(tryNormalizeAddress("0x123")).toBeNull();
    expect(() => normalizeAddress("nope")).toThrow();
  });

  it("recognizes Basenames syntax only", () => {
    expect(looksLikeBasename("alice.base.eth")).toBe(true);
    expect(looksLikeBasename("Alice.Base.ETH")).toBe(true);
    expect(looksLikeBasename("alice.eth")).toBe(false);
    expect(looksLikeBasename("0xabc")).toBe(false);
  });

  it("compares addresses case-insensitively", () => {
    expect(isSameAddress("0xABC0000000000000000000000000000000000000", "0xabc0000000000000000000000000000000000000")).toBe(true);
    expect(isSameAddress(null, "0x")).toBe(false);
  });

  it("detects B20 precompile address shape", () => {
    expect(isB20PrecompileAddress("0xb20000000000000000000078ee7ce2fE4908108C")).toBe(true);
    expect(isB20PrecompileAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).toBe(false);
  });
});
