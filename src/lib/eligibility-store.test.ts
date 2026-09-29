import { afterEach, describe, expect, it, vi } from "vitest";
import { ELIGIBILITY_HEADER, eligibilityHeaders, headerAttested, storeAttestation, storedAttestation } from "./eligibility-store";

const store = new Map<string, string>();
const fakeWindow = {
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
};

afterEach(() => {
  vi.unstubAllGlobals();
  store.clear();
});

describe("the eligibility answer as the browser keeps it", () => {
  it("sends the header only after the visitor answered, for 30 days", () => {
    vi.stubGlobal("window", fakeWindow);
    const now = Date.UTC(2026, 8, 30);
    storeAttestation(false, now);
    expect(eligibilityHeaders()).toEqual({});
    storeAttestation(true, now);
    expect(eligibilityHeaders()).toEqual({ [ELIGIBILITY_HEADER]: "confirmed" });
    expect(storedAttestation(now + 29 * 86_400_000)).toBe(true);
    expect(storedAttestation(now + 31 * 86_400_000)).toBe(false);
    storeAttestation(false, now);
    expect(storedAttestation(now)).toBe(false);
  });

  it("still holds the answer for the page when storage is refused", () => {
    const denied = () => {
      throw new Error("denied");
    };
    vi.stubGlobal("window", { localStorage: { getItem: denied, setItem: denied, removeItem: () => undefined } });
    const now = Date.now();
    storeAttestation(true, now);
    expect(storedAttestation(now)).toBe(true);
    storeAttestation(false, now);
    expect(storedAttestation(now)).toBe(false);
  });

  it("knows nothing on the server", () => {
    expect(storedAttestation()).toBe(false);
    expect(eligibilityHeaders()).toEqual({});
  });

  it("reads the header only when it says confirmed", () => {
    expect(headerAttested(new Headers({ [ELIGIBILITY_HEADER]: "confirmed" }))).toBe(true);
    expect(headerAttested(new Headers({ [ELIGIBILITY_HEADER]: "yes" }))).toBe(false);
    expect(headerAttested(new Headers())).toBe(false);
  });
});
