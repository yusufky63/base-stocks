import { createPublicClient, fallback, http } from "viem";
import { base } from "viem/chains";
import { serverEnv } from "@/config/env";
import { PUBLIC_BASE_RPC_URLS } from "@/config/chain";

/**
 * Keyed RPCs first — the primary (Alchemy, 2 retries) then the secondary (dRPC) — followed by the
 * CDP endpoint when one is configured, then the public endpoints (1 retry each), tried in order.
 * The CDP paymaster URL doubles as a full Base JSON-RPC node; the fallbacks only ever see traffic
 * while everything ahead of them is down, so they cost nothing in normal operation but are far
 * more reliable than the public endpoints during an outage.
 */
function buildTransport(url: string | undefined, secondaryUrl: string | undefined, timeoutMs: number) {
  const cdp = process.env.NEXT_PUBLIC_PAYMASTER_URL?.trim();
  const chain = [
    ...(url ? [http(url, { timeout: timeoutMs, batch: true, retryCount: 2 })] : []),
    ...(secondaryUrl && secondaryUrl !== url ? [http(secondaryUrl, { timeout: timeoutMs, batch: true, retryCount: 1 })] : []),
    ...(cdp && cdp !== url ? [http(cdp, { timeout: timeoutMs, batch: true, retryCount: 1 })] : []),
    ...PUBLIC_BASE_RPC_URLS.filter((u) => u !== url).map((u) => http(u, { timeout: timeoutMs, batch: true, retryCount: 1 })),
  ];
  return fallback(chain, { rank: false });
}

function createBaseClient(transport: ReturnType<typeof fallback>, multicall: boolean) {
  return createPublicClient({
    chain: base,
    transport,
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
  publicClient = createBaseClient(buildTransport(env.BASE_RPC_URL, env.DRPC_RPC_URL, 10_000), true);
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
  // The configured endpoint gets mainnet.base.org behind it so preconfirm status survives its outage;
  // other public RPCs are left out on purpose (they would answer, without the pending tag).
  const primary = env.FLASHBLOCKS_RPC_URL ?? "https://mainnet.base.org";
  const urls = primary === "https://mainnet.base.org" ? [primary] : [primary, "https://mainnet.base.org"];
  flashblocksClient = createBaseClient(fallback(urls.map((u) => http(u, { timeout: 5_000, batch: true, retryCount: 1 })), { rank: false }), false);
  return flashblocksClient;
}
