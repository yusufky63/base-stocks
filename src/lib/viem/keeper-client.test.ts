import { beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * The keeper's signer, built from a key generated here. Building a wallet client opens no
 * connection, so nothing in this file reaches an RPC.
 */
const h = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock("@/config/env", () => ({ serverEnv: () => h.env }));

// The module keeps the account and the client for the life of the process; each test gets a fresh copy.
const load = async () => {
  vi.resetModules();
  return import("./keeper-client");
};

type FallbackTransport = { transports: Array<{ value?: { url?: string } }> };

beforeEach(() => {
  h.env = {};
});

describe("keeper-client", () => {
  it("is absent without AUTOMATION_KEEPER_KEY", async () => {
    const k = await load();
    expect(k.keeperAccount()).toBeNull();
    expect(k.isKeeperConfigured()).toBe(false);
    expect(k.keeperAddress()).toBeNull();
    expect(k.getKeeperWalletClient()).toBeNull();
  });

  it("signs as the address the key derives, on Base", async () => {
    const key = generatePrivateKey();
    h.env = { AUTOMATION_KEEPER_KEY: key };
    const k = await load();
    const expected = privateKeyToAccount(key).address;
    expect(k.isKeeperConfigured()).toBe(true);
    expect(k.keeperAddress()).toBe(expected);
    const wallet = k.getKeeperWalletClient()!;
    expect(wallet.account.address).toBe(expected);
    expect(wallet.chain.id).toBe(8453);
    expect(k.getKeeperWalletClient()).toBe(wallet);
  });

  it("reads the key once per process", async () => {
    h.env = { AUTOMATION_KEEPER_KEY: generatePrivateKey() };
    const k = await load();
    const first = k.keeperAddress();
    h.env = { AUTOMATION_KEEPER_KEY: generatePrivateKey() };
    expect(k.keeperAddress()).toBe(first);
  });

  it("sends through the keyed RPCs first, then the public ones, each once", async () => {
    h.env = { AUTOMATION_KEEPER_KEY: generatePrivateKey(), BASE_RPC_URL: "https://base.keyed.example/v2/k", DRPC_RPC_URL: "https://mainnet.base.org" };
    const k = await load();
    const urls = (k.getKeeperWalletClient()!.transport as unknown as FallbackTransport).transports.map((t) => t.value?.url);
    expect(urls).toEqual(["https://base.keyed.example/v2/k", "https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.llamarpc.com", "https://1rpc.io/base"]);
  });

  it("does not expose the private key on the account or the client", async () => {
    const key = generatePrivateKey();
    h.env = { AUTOMATION_KEEPER_KEY: key };
    const k = await load();
    const seen = JSON.stringify([k.keeperAccount(), k.getKeeperWalletClient()], (_key, v) => (typeof v === "bigint" ? v.toString() : typeof v === "function" ? undefined : v));
    expect(seen.toLowerCase()).not.toContain(key.slice(2).toLowerCase());
  });
});
