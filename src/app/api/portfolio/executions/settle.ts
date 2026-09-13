import { formatUnits, type Address, type Hash } from "viem";
import type { PortfolioExecutionStep } from "@/domain/portfolio";
import { USDC_DECIMALS } from "@/config/chain";
import { metrics } from "@/lib/http";
import { verifyTrade } from "@/services/tx-verify-service";
import type { StepInput } from "./schema";

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Holds a basket's confirmed legs to their receipts, the way trade rows are held to theirs.
 *
 * Only legs that are *new* as confirmed (not confirmed under that hash in the stored record) are
 * checked, so a status-only patch costs nothing. For each: the receipt must show the stock
 * arriving in the owner's wallet, or the leg is kept as failed with the reason; where the receipt
 * shows the USDC that settled, that figure replaces the browser's `targetUsd`. A receipt not mined
 * yet leaves the leg as the browser filed it, since the statistics count a basket leg only through
 * its verified trade row and the timeline settles it by receipt on its own.
 */
export async function settleSteps(owner: Address, existing: readonly PortfolioExecutionStep[], incoming: readonly StepInput[]): Promise<PortfolioExecutionStep[]> {
  const before = new Map(existing.map((s) => [s.id, s]));
  return Promise.all(
    incoming.map(async (s): Promise<PortfolioExecutionStep> => {
      const step: PortfolioExecutionStep = { ...s, txHash: s.txHash as Hash | undefined };
      const prev = before.get(s.id);
      const newlyConfirmed = s.status === "confirmed" && !!s.txHash && !(prev?.status === "confirmed" && prev.txHash?.toLowerCase() === s.txHash.toLowerCase());
      if (!newlyConfirmed) return step;
      try {
        const v = await verifyTrade({ txHash: s.txHash as Hash, owner, assetAddress: s.assetAddress, side: s.side });
        if (v.ok) {
          if (v.usdcAmount !== null) step.targetUsd = round2(Number(formatUnits(v.usdcAmount, USDC_DECIMALS)));
          return step;
        }
        if (v.state === "mismatch" || v.state === "reverted") {
          metrics.count("exec.step.verify", false, v.reason);
          return { ...step, status: "failed", errorCode: v.state === "reverted" ? "REVERTED" : "MISMATCH", errorMessage: v.reason.slice(0, 300) };
        }
        // Pending: the browser may be ahead of this RPC by a block. Kept as filed; the receipt decides later.
        return step;
      } catch (err) {
        metrics.count("exec.step.verify", false, err instanceof Error ? err.message : String(err));
        return step;
      }
    }),
  );
}
