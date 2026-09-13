import type { Hash } from "viem";
import { getFastReceiptClient, getServerPublicClient } from "@/lib/viem/server-client";
import { metrics } from "@/lib/http";

export type TxStatus = "unknown" | "submitted" | "preconfirmed" | "confirmed" | "failed";

export interface TxStatusResult {
  status: TxStatus;
  blockNumber?: number;
  /** Which path produced the status (for observability/UI debug). */
  via: "receipt" | "fast" | "mempool" | "none";
}

export interface ConfirmationProvider {
  getStatus(hash: Hash): Promise<TxStatusResult>;
}

/**
 * The latest sealed block, remembered for a second. The client polls a submitted hash every 1.2 s
 * and each poll read the block number afresh beside the receipt, so watching one transaction cost
 * three or four RPC calls a tick. Within a second the number cannot have moved by more than the
 * Flashblocks this exists to tell apart, and one read serves every hash being watched.
 */
const BLOCK_NUMBER_TTL_MS = 1_000;
let latestBlock: { value: bigint; at: number } | null = null;
let latestBlockInflight: Promise<bigint | null> | null = null;

function latestBlockNumber(client: { getBlockNumber(): Promise<bigint> }): Promise<bigint | null> {
  if (latestBlock && Date.now() - latestBlock.at < BLOCK_NUMBER_TTL_MS) return Promise.resolve(latestBlock.value);
  if (latestBlockInflight) return latestBlockInflight;
  latestBlockInflight = client
    .getBlockNumber()
    .then((value) => {
      latestBlock = { value, at: Date.now() };
      return value;
    })
    .catch(() => null)
    .finally(() => {
      latestBlockInflight = null;
    });
  return latestBlockInflight;
}

/**
 * Fast-receipt confirmation with normal receipt fallback (spec §17).
 * - A receipt from the fast RPC whose block is beyond the latest sealed block = preconfirmed
 *   (Flashblocks today; after the Denim hardfork the same call returns canonical 200ms blocks and
 *   this path simply reports confirmed-grade data faster).
 * - A receipt from the regular RPC (or sealed block) = confirmed / failed.
 * - `base_transactionStatus` == Known = submitted (in mempool).
 * Block-cadence changes only touch this adapter.
 */
export class FastReceiptConfirmationProvider implements ConfirmationProvider {
  async getStatus(hash: Hash): Promise<TxStatusResult> {
    const normal = getServerPublicClient();
    const fast = getFastReceiptClient();

    const [receipt, latest] = await Promise.all([normal.getTransactionReceipt({ hash }).catch(() => null), latestBlockNumber(normal)]);
    if (receipt) {
      if (latest === null || receipt.blockNumber <= latest) {
        return { status: receipt.status === "success" ? "confirmed" : "failed", blockNumber: Number(receipt.blockNumber), via: "receipt" };
      }
      return { status: receipt.status === "success" ? "preconfirmed" : "failed", blockNumber: Number(receipt.blockNumber), via: "fast" };
    }

    // Flashblocks-aware endpoint may already know the receipt.
    try {
      const fastReceipt = await fast.getTransactionReceipt({ hash });
      if (fastReceipt) {
        metrics.count("tx.preconfirmed");
        return { status: fastReceipt.status === "success" ? "preconfirmed" : "failed", blockNumber: Number(fastReceipt.blockNumber), via: "fast" };
      }
    } catch {
      /* not available on this endpoint */
    }

    // Mempool knowledge.
    try {
      const res = (await fast.request({
        method: "base_transactionStatus" as never,
        params: [hash] as never,
      })) as { status?: string } | null;
      if (res?.status === "Known") return { status: "submitted", via: "mempool" };
    } catch {
      /* method unsupported */
    }
    try {
      const tx = await normal.getTransaction({ hash });
      if (tx) return { status: "submitted", via: "mempool" };
    } catch {
      /* ignore */
    }
    return { status: "unknown", via: "none" };
  }
}

export const confirmationService: ConfirmationProvider = new FastReceiptConfirmationProvider();
