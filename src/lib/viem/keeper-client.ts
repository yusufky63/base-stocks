import { createWalletClient, fallback, http, type Address } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { base } from "viem/chains";
import { serverEnv } from "@/config/env";
import { PUBLIC_BASE_RPC_URLS } from "@/config/chain";

/**
 * The AutoInvest keeper's signer. Server-only, built lazily from `AUTOMATION_KEEPER_KEY`; absent
 * means "no keeper here" and the app says so rather than pretending runs will happen.
 */
function build(account: PrivateKeyAccount) {
  const env = serverEnv();
  const urls = [env.BASE_RPC_URL, env.DRPC_RPC_URL, ...PUBLIC_BASE_RPC_URLS].filter((u, i, all): u is string => !!u && all.indexOf(u) === i);
  return createWalletClient({ account, chain: base, transport: fallback(urls.map((u) => http(u, { timeout: 15_000, retryCount: 1 })), { rank: false }) });
}

export type KeeperWalletClient = ReturnType<typeof build>;

let account: PrivateKeyAccount | null | undefined;
let client: KeeperWalletClient | null = null;

export function keeperAccount(): PrivateKeyAccount | null {
  if (account !== undefined) return account;
  const key = serverEnv().AUTOMATION_KEEPER_KEY;
  account = key ? privateKeyToAccount(key as `0x${string}`) : null;
  return account;
}

export function isKeeperConfigured(): boolean {
  return keeperAccount() !== null;
}

export function keeperAddress(): Address | null {
  return keeperAccount()?.address ?? null;
}

export function getKeeperWalletClient(): KeeperWalletClient | null {
  const acct = keeperAccount();
  if (!acct) return null;
  if (!client) client = build(acct);
  return client;
}
