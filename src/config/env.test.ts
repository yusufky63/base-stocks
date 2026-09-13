import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { parseServerEnv } from "./env";

describe("serverEnv", () => {
  const saved = { ...process.env };
  beforeEach(() => {
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
    expect(env.KYBER_API_KEY).toBeUndefined();
    expect(env.ADMIN_API_TOKEN).toBeUndefined();
    expect(env.KYBER_CLIENT_ID).toBe("bstocks-app");
  });

  /** One malformed optional key used to take every route down; now it is dropped and named. */
  it("ignores a malformed optional value with a warning instead of throwing", () => {
    const { env, warnings } = parseServerEnv({ DRPC_RPC_URL: "not a url", AI_MAX_OUTPUT_TOKENS: "99999", ADMIN_API_TOKEN: "0123456789abcdef" });
    expect(env.DRPC_RPC_URL).toBeUndefined();
    expect(env.AI_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect(env.ADMIN_API_TOKEN).toBe("0123456789abcdef");
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).toMatch(/DRPC_RPC_URL/);
    expect(warnings.join(" ")).toMatch(/AI_MAX_OUTPUT_TOKENS/);
  });

  /** A defaulted field that is malformed falls back to its default, and says so, rather than taking the site down. */
  it("falls a malformed defaulted field back to its default with a warning", () => {
    const { env, warnings } = parseServerEnv({ NODE_ENV: "staging", AUTOMATION_MAX_RUNS_PER_TICK: "999" });
    expect(env.NODE_ENV).toBe("development");
    expect(env.AUTOMATION_MAX_RUNS_PER_TICK).toBe(6);
    expect(warnings).toHaveLength(2);
  });

  it("keeps the output-token ceiling in step with the provider clamp", () => {
    expect(parseServerEnv({ AI_MAX_OUTPUT_TOKENS: "3000" }).env.AI_MAX_OUTPUT_TOKENS).toBe(3000);
  });
});
