import type { Hash } from "viem";
import { getRepos } from "@/db/repositories";
import { metrics } from "@/lib/http";
import { invalidate } from "@/lib/cache";
import { settleTrade } from "@/app/api/trades/route";
import { settleGiftClaim, settleGiftFunding } from "@/app/api/gifts/[id]/route";
import { settlePoolFunding } from "@/app/api/pools/[id]/route";
import { verifyEarn, verifyPoolClaim } from "./tx-verify-service";
import { formatUnits } from "viem";
import { USDC_DECIMALS } from "@/config/chain";

/**
 * The verification sweep: every record filed while its receipt was still pending is matched to
 * the chain once the receipt is in. Runs from the cron and before the statistics. A record whose
 * receipt never appears is given a day and then marked failed; one the receipt contradicts is
 * marked failed with the reason, so a hash filed under the wrong wallet can never count.
 */
const BATCH = 100;
/** How long a pending record may wait for its receipt before it is written off. */
const PENDING_GRACE_MS = 24 * 3600_000;

export interface VerifySweepResult {
  trades: { checked: number; verified: number; failed: number };
  gifts: { checked: number; verified: number; failed: number };
  earn: { checked: number; verified: number; failed: number };
  pools: { checked: number; verified: number; failed: number };
  claims: { checked: number; verified: number; failed: number };
}

const isHash = (h: string | undefined | null): h is Hash => !!h && /^0x[0-9a-fA-F]{64}$/.test(h);
const zero = () => ({ checked: 0, verified: 0, failed: 0 });

export async function verifyPendingRecords(): Promise<VerifySweepResult> {
  const repos = getRepos();
  const now = Date.now();
  const result: VerifySweepResult = { trades: zero(), gifts: zero(), earn: zero(), pools: zero(), claims: zero() };
  const writeOff = (createdAt: number) => now - createdAt > PENDING_GRACE_MS;

  for (const t of await repos.trades.listUnverified(BATCH).catch(() => [])) {
    if (!isHash(t.txHash) || t.status === "failed") continue;
    result.trades.checked += 1;
    try {
      const s = await settleTrade(t, t.txHash);
      if (s.verifiedAt) {
        await repos.trades.update(t.id, { status: "confirmed", usdValue: s.usdValue, buyAmount: s.buyAmount, sellAmount: s.sellAmount, verifiedAt: s.verifiedAt });
        result.trades.verified += 1;
      } else if (s.status === "failed" || writeOff(t.createdAt)) {
        await repos.trades.update(t.id, { status: "failed", verifyNote: s.verifyNote ?? "no receipt within a day" });
        result.trades.failed += 1;
      }
    } catch (err) {
      // A receipt that contradicts the record (or a hash the network never saw): the record is not this wallet's.
      await repos.trades.update(t.id, { status: "failed", verifyNote: err instanceof Error ? err.message.slice(0, 200) : "mismatch" }).catch(() => undefined);
      result.trades.failed += 1;
    }
  }

  for (const g of await repos.gifts.listUnverified(BATCH).catch(() => [])) {
    if (!isHash(g.txHash) || g.status === "failed") continue;
    result.gifts.checked += 1;
    try {
      // The funding first; then, when a claim or refund was reported while pending, that transaction.
      const funded = await settleGiftFunding(g, g.txHash);
      if (!funded.verifiedAt) {
        if (funded.status === "failed" || writeOff(g.createdAt)) {
          await repos.gifts.update(g.id, { status: "failed", verifyNote: funded.verifyNote ?? "no receipt within a day" });
          result.gifts.failed += 1;
        }
        continue;
      }
      let patch = funded;
      const pendingClaim = g.verifyNote?.startsWith("pending:") ? (g.verifyNote.slice(8) as "claimed" | "reclaimed") : null;
      if (pendingClaim && isHash(g.claimTx)) patch = { ...patch, ...(await settleGiftClaim(g, g.claimTx, pendingClaim)) };
      await repos.gifts.update(g.id, patch);
      result.gifts.verified += 1;
    } catch (err) {
      await repos.gifts.update(g.id, { status: "failed", verifyNote: err instanceof Error ? err.message.slice(0, 200) : "mismatch" }).catch(() => undefined);
      result.gifts.failed += 1;
    }
  }

  for (const a of await repos.earnActions.listUnverified(BATCH).catch(() => [])) {
    if (!isHash(a.txHash) || a.verifyNote) continue;
    result.earn.checked += 1;
    const v = await verifyEarn({ txHash: a.txHash, owner: a.owner, provider: a.provider, action: a.action });
    if (v.ok) {
      await repos.earnActions.update(a.id, {
        verifiedAt: Date.now(),
        ...(v.amount !== null ? { amount: v.amount.toString(), usdValue: Math.round(Number(formatUnits(v.amount, USDC_DECIMALS)) * 100) / 100 } : {}),
      });
      result.earn.verified += 1;
    } else if (v.state !== "pending" || writeOff(a.createdAt)) {
      await repos.earnActions.update(a.id, { verifyNote: v.state === "pending" ? "no receipt within a day" : v.reason.slice(0, 200) });
      result.earn.failed += 1;
    }
  }

  for (const p of await repos.pools.listUnverified(BATCH).catch(() => [])) {
    if (!isHash(p.txHash) || p.status === "failed" || p.status === "draft") continue;
    result.pools.checked += 1;
    try {
      const s = await settlePoolFunding(p, p.txHash);
      if (s.verifiedAt) {
        await repos.pools.update(p.id, s);
        result.pools.verified += 1;
      } else if (s.status === "failed" || writeOff(p.createdAt)) {
        await repos.pools.update(p.id, { status: "failed", verifyNote: s.verifyNote ?? "no receipt within a day" });
        result.pools.failed += 1;
      }
    } catch (err) {
      await repos.pools.update(p.id, { status: "failed", verifyNote: err instanceof Error ? err.message.slice(0, 200) : "mismatch" }).catch(() => undefined);
      result.pools.failed += 1;
    }
  }

  // Claims a page reported while their receipt was pending: prove them, or hand the ticket back.
  const pools = new Map((await repos.pools.listAll().catch(() => [])).map((p) => [p.id, p]));
  for (const c of (await repos.poolClaims.listAll(BATCH * 5).catch(() => [])).filter((c) => c.status === "confirmed" && isHash(c.txHash)).slice(0, BATCH)) {
    const pool = pools.get(c.poolId);
    if (!pool) continue;
    result.claims.checked += 1;
    const v = await verifyPoolClaim(pool, c.claimant, c.txHash as Hash);
    if (v.ok) {
      await repos.poolClaims.update(c.poolId, c.claimant, { status: "reconciled", blockNumber: v.blockNumber }).catch(() => null);
      result.claims.verified += 1;
    } else if (v.state !== "pending" || writeOff(c.createdAt)) {
      // Back to a ticket: the row keeps its hash for audit, and stops counting.
      await repos.poolClaims.update(c.poolId, c.claimant, { status: "issued" }).catch(() => null);
      result.claims.failed += 1;
    }
  }

  const touched = Object.values(result).reduce((s, r) => s + r.verified + r.failed, 0);
  if (touched > 0) invalidate("stats:");
  metrics.count("verify.sweep", true, JSON.stringify(result));
  return result;
}
