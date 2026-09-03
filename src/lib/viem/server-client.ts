import { createPublicClient, fallback, http } from "viem";
import { base } from "viem/chains";
import { serverEnv } from "@/config/env";
import { PUBLIC_BASE_RPC_URLS } from "@/config/chain";

function buildTransport(url: string | undefined, timeoutMs: number) {
  if (url) {
    return http(url, { timeout: timeoutMs, batch: true, retryCount: 2 });
  }
  return fallback(
    PUBLIC_BASE_RPC_URLS.map((u) => http(u, { timeout: timeoutMs, batch: true, retryCount: 1 })),
    { rank: false },
  );
}

function createBaseClient(url: string | undefined, timeoutMs: number, multicall: boolean) {
  return createPublicClient({
    chain: base,
    transport: buildTransport(url, timeoutMs),
    batch: multicall ? { multicall: { wait: 8, batchSize: 2048 } } : undefined,
  });
}

export type BasePublicClient = ReturnType<typeof createBaseClient>;

let publicClient: BasePublicClient | null = null;
let flashblocksClient: BasePublicClient | null = null;

/**
 * Shared server-side public client for Base mainnet.
 * Multicall batching is enabled so parallel reads collapse into a few RPC requests.
 */
export function getServerPublicClient(): BasePublicClient {
  if (publicClient) return publicClient;
  const env = serverEnv();
  publicClient = createBaseClient(env.BASE_RPC_URL, 10_000, true);
  return publicClient;
}

/**
 * Flashblocks-aware client used only by the confirmation service.
 * Falls back to the regular RPC when no dedicated endpoint is configured.
 */
export function getFlashblocksClient(): BasePublicClient {
  if (flashblocksClient) return flashblocksClient;
  const env = serverEnv();
  // mainnet.base.org is Flashblocks-aware (pending-tag state); a dedicated RPC (Alchemy etc.) usually is not.
  flashblocksClient = createBaseClient(env.FLASHBLOCKS_RPC_URL ?? "https://mainnet.base.org", 5_000, false);
  return flashblocksClient;
}
