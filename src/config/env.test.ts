import { describe, expect, it, beforeEach, afterEach } from "vitest";

describe("serverEnv", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.FLASHBLOCKS_RPC_URL = "";
    process.env.KYBER_API_KEY = "";
    process.env.ADMIN_API_TOKEN = "   ";
    process.env.ZEROX_SWAP_FEE_RECIPIENT = "";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("treats blank dotenv values as unset instead of failing validation", async () => {
    const { serverEnv } = await import("./env");
    const env = serverEnv();
    expect(env.FLASHBLOCKS_RPC_URL).toBeUndefined();
    expect(env.KYBER_API_KEY).toBeUndefined();
    expect(env.ADMIN_API_TOKEN).toBeUndefined();
    expect(env.KYBER_CLIENT_ID).toBe("bstocks-app");
  });
});
