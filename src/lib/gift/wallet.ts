import type { Address, Hash, Hex, PublicClient, WalletClient } from "viem";
import { base } from "viem/chains";
import { BASE_CHAIN_ID } from "@/config/chain";
import { publicEnv } from "@/config/env";
import { attributionCapabilities, withAttribution } from "@/lib/attribution";
import { humanizeError, type HumanError } from "@/lib/errors";

/**
 * The one wallet-capability probe and the one send routine behind every gift and pool
 * transaction. Six components used to carry their own copy of "ask for capabilities, try
 * sendCalls, fall back to one transaction at a time", and they had drifted: some forced atomic
 * batches, some sponsored gas for anyone, some simulated first and some did not. The differences
 * that matter are options here; the rest is written once.
 */
export interface WalletCaps {
  /** The wallet can batch the calls into one atomic transaction (Base Account). */
  atomic: boolean;
  /** The wallet accepts a paymaster and this deployment has one configured. */
  paymaster: boolean;
}

/** Asks the wallet what it can do. A wallet that does not answer gets the plain-transaction path. */
export async function probeWalletCapabilities(walletClient: WalletClient, address: Address): Promise<WalletCaps> {
  try {
    const caps = (await walletClient.getCapabilities({ account: address, chainId: BASE_CHAIN_ID })) as { atomic?: { status?: string }; paymasterService?: { supported?: boolean } };
    return {
      atomic: caps.atomic?.status === "supported" || caps.atomic?.status === "ready",
      paymaster: !!publicEnv.paymasterUrl && !!caps.paymasterService?.supported,
    };
  } catch {
    return { atomic: false, paymaster: false };
  }
}

export interface Call {
  to: Address;
  /** Raw calldata; the attribution suffix is added here, once. */
  data: Hex;
}

export interface SendOptions {
  walletClient: WalletClient;
  publicClient: PublicClient;
  address: Address;
  calls: Call[];
  caps: WalletCaps;
  /**
   * Sponsor gas where the wallet allows it. Off by default: a sponsored claim on an open pool is a
   * free sybil, so only the gated paths and the sender's own deposits turn it on.
   */
  sponsor?: boolean;
  /**
   * Try EIP-5792 even when the wallet makes no atomic promise: one prompt, calls run in order.
   * A wallet that does not implement the method says so and we walk to the sequential path.
   */
  batchWithoutAtomic?: boolean;
  /** Runs before each call on the sequential path (a simulation, an allowance re-check). */
  preflight?: (call: Call, index: number) => Promise<void>;
  /** Called once the wallet has accepted the request and the chain is doing the rest. */
  onSubmitted?: () => void;
  timeoutMs?: number;
}

export interface SendResult {
  /** One hash per call. An atomic batch is one transaction, so every entry is the same hash. */
  hashes: Array<Hash | undefined>;
  last: Hash | undefined;
}

const NOT_IMPLEMENTED = /unsupported|not supported|does not exist|Method not found|4200|5700/i;

/**
 * Sends the calls the best way the wallet allows: one atomic batch, one non-atomic batch when
 * asked for, or one transaction after another, waiting for each receipt.
 */
export async function sendCallsOrSequential(opts: SendOptions): Promise<SendResult> {
  const { walletClient, publicClient, address, calls, caps } = opts;
  const attributed = calls.map((c) => ({ to: c.to, data: withAttribution(c.data) }));
  const capabilities = { ...attributionCapabilities(), ...(opts.sponsor && caps.paymaster ? { paymasterService: { url: publicEnv.paymasterUrl } } : {}) };

  if (caps.atomic || opts.batchWithoutAtomic) {
    try {
      const { id } = await walletClient.sendCalls({ account: address, chain: base, ...(caps.atomic ? { forceAtomic: true } : {}), calls: attributed, capabilities });
      opts.onSubmitted?.();
      const result = await walletClient.waitForCallsStatus({ id, timeout: opts.timeoutMs ?? 180_000 });
      if (result.status === "failure") throw new Error("The batched transaction failed onchain.");
      const receipts = result.receipts ?? [];
      // A non-atomic batch returns one receipt per call; an atomic one returns a single receipt
      // that every call shares.
      const hashes = calls.map((_, i) => (receipts.length === calls.length ? receipts[i]?.transactionHash : receipts[receipts.length - 1]?.transactionHash));
      return { hashes, last: hashes[hashes.length - 1] };
    } catch (err) {
      // Only "I do not do that" falls through to one transaction at a time. A decline or a revert
      // is a real answer and belongs to the caller.
      if (!NOT_IMPLEMENTED.test(err instanceof Error ? err.message : String(err))) throw err;
    }
  }

  const hashes: Array<Hash | undefined> = [];
  for (let i = 0; i < calls.length; i++) {
    await opts.preflight?.(calls[i]!, i);
    const hash = await walletClient.sendTransaction({ account: address, chain: base, to: attributed[i]!.to, data: attributed[i]!.data });
    if (i === 0) opts.onSubmitted?.();
    await publicClient.waitForTransactionReceipt({ hash });
    hashes.push(hash);
  }
  return { hashes, last: hashes[hashes.length - 1] };
}

/**
 * A claim that failed for want of gas is not the claimant's fault and has a fix: the sponsored
 * passkey path. Everything else keeps the generic wording.
 */
export function explainClaimError(err: unknown): HumanError {
  const h = humanizeError(err);
  if (/insufficient funds/i.test(h.detail ?? "")) {
    return { ...h, message: "This wallet has no ETH for gas. Claim with a Base Account (passkey) instead — the fee is covered for you." };
  }
  return h;
}

/**
 * A react-query `refetchInterval` that stops while the tab is hidden. A claim page left open in a
 * background tab used to read the contract every few seconds for nobody.
 */
export function pollWhenVisible(ms: number): () => number | false {
  return () => (typeof document !== "undefined" && document.hidden ? false : ms);
}
