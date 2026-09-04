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

    const [receipt, latest] = await Promise.all([
      normal.getTransactionReceipt({ hash }).catch(() => null),
      normal.getBlockNumber().catch(() => null),
    ]);
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
