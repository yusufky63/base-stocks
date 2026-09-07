import { createPublicClient, fallback, http } from "viem";
import { base } from "viem/chains";
import { serverEnv } from "@/config/env";
import { PUBLIC_BASE_RPC_URLS } from "@/config/chain";

/**
 * Server-side Base reads, spread across every keyed provider instead of piled on one.
 *
 * This used to be a single `fallback` list with Alchemy at its head, which meant Alchemy served
 * 100% of traffic and everything behind it was insurance that never billed. Here each keyed
 * provider leads its own client with the others queued behind it, and calls rotate between those
 * clients by weight. The bill divides; a provider going down still costs one retried request
 * rather than a page.
 *
 * The rotation happens per `getServerPublicClient()` call rather than per read, so viem's
 * multicall batching still collapses a handler's parallel reads into one request — on whichever
 * provider that handler drew.
 */

type Provider = { name: string; url: string };

/**
 * The keyed endpoints, in the order they are trusted for wide reads.
 *
 * CDP is last on purpose: its node caps `eth_getLogs` at 1,000 blocks and charges 100 billing
 * units for it, so a sweep that lands there splits into several requests. For ordinary calls it is
 * an equal member of the rotation.
 */
function keyedProviders(): Provider[] {
  const env = serverEnv();
  const seen = new Set<string>();
  const out: Provider[] = [];
  for (const [name, url] of [
    ["alchemy", env.BASE_RPC_URL],
    ["drpc", env.DRPC_RPC_URL],
    // The CDP paymaster URL doubles as a full Base JSON-RPC node.
    ["cdp", process.env.NEXT_PUBLIC_PAYMASTER_URL?.trim()],
  ] as const) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ name, url });
  }
  return out;
}

/**
 * `RPC_WEIGHTS="alchemy=1,drpc=2,cdp=2"` — how many slots of five each provider takes. Unset, and
 * every configured provider weighs the same, which is the point of the file: an even split is
 * already a third of the old load on any one account. A weight of 0 removes a provider from the
 * rotation without removing it as a fallback.
 */
function parseWeights(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const pair of raw?.split(",") ?? []) {
    const [name, value] = pair.split("=");
    const n = Number(value);
    if (name?.trim() && Number.isFinite(n) && n >= 0) out.set(name.trim(), Math.min(Math.floor(n), 100));
  }
  return out;
}

function createBaseClient(lead: Provider | null, others: Provider[], timeoutMs: number, multicall: boolean) {
  const keyed = new Set([...(lead ? [lead.url] : []), ...others.map((p) => p.url)]);
  const chain = [
    ...(lead ? [http(lead.url, { timeout: timeoutMs, batch: true, retryCount: 2 })] : []),
    ...others.map((p) => http(p.url, { timeout: timeoutMs, batch: true, retryCount: 1 })),
    ...PUBLIC_BASE_RPC_URLS.filter((u) => !keyed.has(u)).map((u) => http(u, { timeout: timeoutMs, batch: true, retryCount: 1 })),
  ];
  return createPublicClient({
    chain: base,
    transport: fallback(chain, { rank: false }),
    batch: multicall ? { multicall: { wait: 8, batchSize: 2048 } } : undefined,
  });
}

export type BasePublicClient = ReturnType<typeof createBaseClient>;

type Pool = {
  providers: Provider[];
  /** One client per provider, each leading its own failover chain. */
  clients: BasePublicClient[];
  /** Provider index per slot, expanded from the weights so the split is exact rather than sampled. */
  slots: number[];
  /** The subset that serves wide `eth_getLogs` ranges, in the same slot form. */
  logSlots: number[];
  cursor: number;
  logCursor: number;
};

let pool: Pool | null = null;
let fastReceiptClient: BasePublicClient | null = null;

function ensurePool(): Pool {
  if (pool) return pool;
  const providers = keyedProviders();
  const weights = parseWeights(serverEnv().RPC_WEIGHTS);
  const clients = providers.length
    ? providers.map((p, i) => createBaseClient(p, providers.filter((_, j) => j !== i), 10_000, true))
    : // Nothing keyed configured: one public-only client, same shape as the rest.
      [createBaseClient(null, [], 10_000, true)];

  const slots: number[] = [];
  const logSlots: number[] = [];
  providers.forEach((p, i) => {
    const weight = weights.get(p.name) ?? 1;
    for (let n = 0; n < weight; n += 1) {
      slots.push(i);
      // A sweep that lands on CDP has to be split into 1,000-block requests, so it leads log reads
      // only when it is the sole provider left.
      if (p.name !== "cdp") logSlots.push(i);
    }
  });
  // Every weight zero (or no providers at all) still has to answer: fall back to plain rotation.
  if (!slots.length) slots.push(...clients.map((_, i) => i));
  if (!logSlots.length) logSlots.push(...slots);

  pool = { providers, clients, slots, logSlots, cursor: 0, logCursor: 0 };
  return pool;
}

/**
 * Shared server-side public client for Base mainnet, drawn from the weighted rotation.
 *
 * Multicall batching is enabled, so parallel reads made through the client this returns collapse
 * into a few requests. Call it once per unit of work and reuse the result; calling it per read
 * would scatter reads that would otherwise have batched.
 */
export function getServerPublicClient(): BasePublicClient {
  const p = ensurePool();
  const idx = p.slots[p.cursor % p.slots.length]!;
  p.cursor = (p.cursor + 1) % p.slots.length;
  return p.clients[idx]!;
}

/**
 * The client for `eth_getLogs` sweeps: the same rotation minus any provider that caps block
 * ranges, so a wide scan is one request rather than a halving cascade. Capped providers stay in
 * the chain behind it, where the adaptive splitting in the index service can still cope.
 */
export function getLogPublicClient(): BasePublicClient {
  const p = ensurePool();
  const idx = p.logSlots[p.logCursor % p.logSlots.length]!;
  p.logCursor = (p.logCursor + 1) % p.logSlots.length;
  return p.clients[idx]!;
}

/** Which providers are in the rotation, and in what proportion. Read by the admin overview. */
export function rpcRotation(): Array<{ name: string; share: number; leadsLogs: boolean }> {
  const p = ensurePool();
  return p.providers.map((provider, i) => ({
    name: provider.name,
    share: p.slots.filter((s) => s === i).length / p.slots.length,
    leadsLogs: p.logSlots.includes(i),
  }));
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
  // Built directly rather than through createBaseClient, which would append the public endpoints.
  fastReceiptClient = createPublicClient({
    chain: base,
    transport: fallback([http("https://mainnet.base.org", { timeout: 5_000, batch: true, retryCount: 1 })], { rank: false }),
  });
  return fastReceiptClient;
}
