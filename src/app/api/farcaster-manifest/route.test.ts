import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const read = async () => (await GET().json()) as {
  accountAssociation?: { header: string; payload: string; signature: string };
  baseBuilder?: { allowedAddresses: string[] };
  miniapp: Record<string, unknown>;
};

afterEach(() => vi.unstubAllEnvs());

describe("the mini app manifest", () => {
  it("always describes the app, signed or not", async () => {
    const m = (await read()).miniapp;
    expect(m.version).toBe("1");
    expect(m.name).toBe("BaseStocks");
    expect(m.homeUrl).toMatch(/^https?:\/\//);
    expect(m.iconUrl).toMatch(/^https?:\/\/.+\.png$/);
    expect(m.requiredChains).toEqual(["eip155:8453"]);
    expect((m.tags as string[]).length).toBeLessThanOrEqual(5);
    expect((m.name as string).length).toBeLessThanOrEqual(32);
  });

  /**
   * The signature covers this exact domain and is pasted in long after the code is written. An
   * unsigned manifest should read as unsigned — a block of empty strings looks signed and fails
   * validation with nothing to point at.
   */
  it("omits the account association until it is actually signed", async () => {
    vi.stubEnv("FARCASTER_ACCOUNT_HEADER", "");
    vi.stubEnv("FARCASTER_ACCOUNT_PAYLOAD", "");
    vi.stubEnv("FARCASTER_ACCOUNT_SIGNATURE", "");
    expect(await read()).not.toHaveProperty("accountAssociation");
  });

  it("omits it when only part of the signature is set", async () => {
    vi.stubEnv("FARCASTER_ACCOUNT_HEADER", "eyJmaWQiOjF9");
    vi.stubEnv("FARCASTER_ACCOUNT_PAYLOAD", "eyJkb21haW4iOiJ4In0");
    vi.stubEnv("FARCASTER_ACCOUNT_SIGNATURE", "   ");
    expect(await read()).not.toHaveProperty("accountAssociation");
  });

  it("serves the signature once all three parts are present", async () => {
    vi.stubEnv("FARCASTER_ACCOUNT_HEADER", " eyJmaWQiOjF9 ");
    vi.stubEnv("FARCASTER_ACCOUNT_PAYLOAD", "eyJkb21haW4iOiJ4In0");
    vi.stubEnv("FARCASTER_ACCOUNT_SIGNATURE", "0xabc");
    expect((await read()).accountAssociation).toEqual({ header: "eyJmaWQiOjF9", payload: "eyJkb21haW4iOiJ4In0", signature: "0xabc" });
  });

  it("takes only well-formed builder addresses, and drops the block when none survive", async () => {
    vi.stubEnv("BASE_BUILDER_ALLOWED_ADDRESSES", "0x78de409a6306550882328E2a67160471368387FF , not-an-address,0xtoo-short");
    expect((await read()).baseBuilder).toEqual({ allowedAddresses: ["0x78de409a6306550882328E2a67160471368387FF"] });
    vi.stubEnv("BASE_BUILDER_ALLOWED_ADDRESSES", "nonsense");
    expect(await read()).not.toHaveProperty("baseBuilder");
  });

  it("lets hosts cache it without pinning a stale signature for long", async () => {
    expect(GET().headers.get("cache-control")).toContain("s-maxage=600");
  });
});
