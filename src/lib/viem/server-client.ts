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
let fastReceiptClient: BasePublicClient | null = null;

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
 * Fast-receipt client used only by the confirmation service. mainnet.base.org serves receipts from
 * Flashblocks preconfirmed state today and will serve canonical 200ms blocks after the Denim
 * hardfork - the plain getTransactionReceipt call this client exists for works identically in both
 * eras, so nothing here changes at activation. Other RPCs are left out on purpose: they answer
 * only at the sealed 2s cadence, which the regular client already covers.
 */
export function getFastReceiptClient(): BasePublicClient {
  if (fastReceiptClient) return fastReceiptClient;
  fastReceiptClient = createBaseClient(fallback([http("https://mainnet.base.org", { timeout: 5_000, batch: true, retryCount: 1 })], { rank: false }), false);
  return fastReceiptClient;
}
