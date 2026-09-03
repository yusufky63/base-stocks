import { describe, expect, it } from "vitest";
import { Attribution } from "ox/erc8021";
import { attributionCapabilities, getBuilderDataSuffix, isAttributionEnabled, withAttribution } from "./attribution";

describe("Builder Code attribution (ERC-8021)", () => {
  it("ships a suffix that decodes back to the registered code", () => {
    const suffix = getBuilderDataSuffix();
    expect(suffix).not.toBeNull();
    expect(isAttributionEnabled()).toBe(true);
    const decoded = Attribution.fromData(suffix!);
    expect(decoded?.codes).toEqual(["bc_71vd6x2w"]);
  });

  it("appends the suffix once and never twice", () => {
    const once = withAttribution("0xdeadbeef");
    expect(once.startsWith("0xdeadbeef")).toBe(true);
    expect(once.length).toBeGreaterThan("0xdeadbeef".length);
    expect(withAttribution(once)).toBe(once);
  });

  it("exposes the EIP-5792 dataSuffix capability as optional", () => {
    const caps = attributionCapabilities();
    expect("dataSuffix" in caps).toBe(true);
    if ("dataSuffix" in caps) {
      expect(caps.dataSuffix.optional).toBe(true);
      expect(caps.dataSuffix.value).toBe(getBuilderDataSuffix());
    }
  });
});
