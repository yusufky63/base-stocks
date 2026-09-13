"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { encodeFunctionData, type Address, type Hash, type Hex } from "viem";
import { Eye, EyeOff, Lock, RefreshCw } from "lucide-react";
import type { PoolClaim, PoolView } from "@/domain/pool";
import { BASE_CHAIN_ID } from "@/config/chain";
import { apiGet, apiPatch, apiPut, ApiError } from "@/lib/client-api";
import { GIFT_POOL_ADDRESS, giftPoolAbi } from "@/lib/pool";
import { patchWithRetry } from "@/lib/gift/record";
import { probeWalletCapabilities, sendCallsOrSequential } from "@/lib/gift/wallet";
import { humanizeError, type HumanError } from "@/lib/errors";
import { useAuth } from "@/hooks/useAuth";
import { useNow } from "@/hooks/useNow";
import { formatTokenAmount, shortenAddress } from "@/lib/format";
import { Badge, Button, Module, ModuleHeader, Skeleton, cx } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/Segmented";
import { ErrorBanner, TxLink } from "@/components/common/display";
import { TimeAgo } from "@/components/common/TimeAgo";

type ClaimRow = PoolClaim & { basename?: string | null; proof?: Array<{ label: string; checked: boolean }> };

/** "2 days 23 hours", "4 hours", "11 minutes" — enough to plan around, no false precision. */
function untilLabel(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days} day${days === 1 ? "" : "s"}` : `${days}d ${rest}h`;
}

/**
 * The creator's side of a pool: who took a share, and the two-step close.
 *
 * Closing is deliberately two transactions' worth of work in one button: `cancel` only flips a
 * flag (so a paused stock can never stop the creator from closing), then `withdraw` moves the
 * remainder. On Base Account both go in one atomic batch; on other wallets they are confirmed one
 * after the other. If a single stock in a package is paused by its issuer, the batch trips on that
 * leg and the per-leg buttons bring the healthy ones home anyway.
 */
export function PoolManagePanel({
  view,
  onChanged,
  lockedUntil,
  cancelled,
  claimed,
  slots,
  expiry,
}: {
  view: PoolView;
  onChanged: () => void;
  lockedUntil: number;
  cancelled: boolean;
  claimed: number;
  slots: number;
  /** The chain's expiry when read, else the record's. */
  expiry?: number;
}) {
  const pool = view.pool;
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });

  // A ticking clock rather than a snapshot: a lock that expires while the page is open should
  // hand the creator their button, not make them reload to find out.
  const now = useNow(30_000);
  const { ensureSignedIn } = useAuth();
  const [busy, setBusy] = useState<"close" | "sync" | "visibility" | number | null>(null);
  const [error, setError] = useState<HumanError | null>(null);
  const [tx, setTx] = useState<Hash | undefined>();

  const claims = useQuery({
    queryKey: ["pool-claims", pool.id],
    queryFn: () => apiGet<{ claims: ClaimRow[]; count: number; creatorOnly: boolean }>(`/api/pools/${pool.id}/claims`),
    refetchInterval: 30_000,
  });

  // `now` is 0 until the clock's first tick (the server snapshot); nothing is decided from it then.
  const locked = now > 0 && lockedUntil > now;
  const expired = now > 0 && now > (expiry ?? pool.expiry);
  const remaining = Math.max(0, slots - claimed);
  const legsOnchain = view.onchain?.legs ?? [];
  const allWithdrawn = legsOnchain.length > 0 && legsOnchain.every((l) => l.withdrawn);

  /** The creator pays their own gas; sponsorship is for claimants. */
  const send = async (calls: Array<{ to: Address; data: Hex }>) => {
    if (!address || !walletClient || !publicClient) throw new Error("Connect your wallet first.");
    const caps = await probeWalletCapabilities(walletClient, address);
    return (await sendCallsOrSequential({ walletClient, publicClient, address, caps: { ...caps, atomic: caps.atomic && calls.length > 1 }, calls })).last;
  };

  const close = async () => {
    setError(null);
    setBusy("close");
    try {
      const calls: Array<{ to: Address; data: Hex }> = [];
      if (!cancelled) {
        calls.push({ to: GIFT_POOL_ADDRESS as Address, data: encodeFunctionData({ abi: giftPoolAbi, functionName: "cancel", args: [pool.onchainId] }) });
      }
      if (!allWithdrawn) {
        calls.push({ to: GIFT_POOL_ADDRESS as Address, data: encodeFunctionData({ abi: giftPoolAbi, functionName: "withdraw", args: [pool.onchainId] }) });
      }
      if (calls.length === 0) return;
      const hash = await send(calls);
      setTx(hash);
      // The cancel is reported with its hash so the server can match it to `PoolCancelled`
      // rather than take the creator's word; the route wants the creator's session for it.
      await ensureSignedIn().catch(() => undefined);
      await patchWithRetry(`/api/pools/${pool.id}`, { status: "cancelled", ...(hash && !cancelled ? { txHash: hash } : {}) });
      onChanged();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setBusy(null);
    }
  };

  const withdrawLeg = async (index: number) => {
    setError(null);
    setBusy(index);
    try {
      const hash = await send([{ to: GIFT_POOL_ADDRESS as Address, data: encodeFunctionData({ abi: giftPoolAbi, functionName: "withdrawLeg", args: [pool.onchainId, BigInt(index)] }) }]);
      setTx(hash);
      onChanged();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Publishing after the fact. A pool is unlisted unless its creator asks otherwise, and until now
   * that choice was frozen at creation — so a pool made in a hurry stayed invisible with no way
   * back. The route already accepted the change; it just had nothing to call it.
   */
  const setVisibility = async (visibility: "public" | "unlisted") => {
    if (visibility === pool.visibility) return;
    setError(null);
    setBusy("visibility");
    try {
      await ensureSignedIn(); // proving the wallet is the creator's is the whole gate here
      await apiPatch(`/api/pools/${pool.id}`, { visibility });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? { code: "UNKNOWN", message: err.message } : humanizeError(err));
    } finally {
      setBusy(null);
    }
  };

  /** A log scan the server only runs for the creator, so it asks for the session first. */
  const sync = async () => {
    setBusy("sync");
    try {
      await ensureSignedIn();
      await apiPut(`/api/pools/${pool.id}/claims`, {});
      await claims.refetch();
      onChanged();
    } catch {
      /* the roster simply stays as it was */
    } finally {
      setBusy(null);
    }
  };

  const rows = claims.data?.claims ?? [];
  const counted = rows.filter((c) => c.status !== "issued").length;

  return (
    <div className="flex flex-col gap-4">
      <Module>
        <ModuleHeader
          title="Your pool"
          action={
            <Button size="sm" variant="secondary" loading={busy === "sync"} onClick={() => void sync()}>
              <RefreshCw size={13} strokeWidth={2} /> Sync with chain
            </Button>
          }
        />
        <div className="grid grid-cols-3 border-b border-line">
          {[
            ["Claimed", `${claimed}`],
            ["Left", `${remaining}`],
            ["Shares", `${slots}`],
          ].map(([k, v]) => (
            <div key={k} className="px-4 py-3 border-r border-line last:border-r-0">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{k}</div>
              <div className="display num text-[22px]">{v}</div>
            </div>
          ))}
        </div>

        <div className="p-4 border-b border-line flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Who can find it</span>
          <Segmented<"unlisted" | "public">
            size="sm"
            className="max-w-[320px]"
            ariaLabel="Who can find this pool"
            value={pool.visibility}
            onChange={(v) => void setVisibility(v)}
            options={[
              { value: "unlisted", label: "By link only", disabled: busy === "visibility" },
              { value: "public", label: "Listed publicly", disabled: busy === "visibility" },
            ]}
          />
          <p className="text-[12px] text-ink-muted inline-flex items-start gap-1.5">
            {pool.visibility === "public" ? <Eye size={13} strokeWidth={1.75} className="mt-0.5 shrink-0" /> : <EyeOff size={13} strokeWidth={1.75} className="mt-0.5 shrink-0" />}
            {pool.visibility === "public"
              ? "Anyone can find this on the pools page, in the Claim tab and on the home page."
              : "Only people you send the link to can reach this. Listing it needs one signature to prove the wallet is yours."}
          </p>
        </div>

        <div className="p-4 flex flex-col gap-3">
          {cancelled && allWithdrawn ? (
            <p className="text-[13px] text-ink-secondary">This pool is closed and everything unclaimed is back in your wallet.</p>
          ) : (
            <>
              <p className="text-[13px] text-ink-secondary">
                {locked
                  ? "Closing stops new claims and returns the unclaimed remainder to your wallet — but you locked this pool, so not yet."
                  : cancelled
                    ? "The pool is closed. Bring the unclaimed remainder home."
                    : expired
                      ? "The claim window has closed. Withdraw the unclaimed remainder."
                      : "Closing stops new claims immediately and returns the unclaimed remainder to your wallet. Shares already taken stay with the people who took them."}
              </p>
              {/* Shown disabled rather than hidden: "what can I do, and when" is the question a
                  locked creator is actually asking, and a missing button answers neither half. */}
              <Button
                variant="danger"
                disabled={locked}
                loading={busy === "close"}
                title={locked ? `Unlocks ${new Date(lockedUntil).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : undefined}
                onClick={() => void close()}
              >
                {locked ? `Locked · unlocks in ${untilLabel(lockedUntil - now)}` : cancelled || expired ? "Withdraw the remainder" : "Close pool and withdraw"}
              </Button>
              {locked && (
                <p className="text-[12px] text-ink-muted inline-flex items-start gap-1.5">
                  <Lock size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" />
                  {`You gave up the right to close this until ${new Date(lockedUntil).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. The contract enforces it against you too — that is what makes the Locked badge worth anything to a claimer.`}
                </p>
              )}
            </>
          )}

          {legsOnchain.length > 1 && !allWithdrawn && (cancelled || expired) && (
            <div className="border-t border-line pt-3 flex flex-col gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Withdraw one at a time</span>
              <p className="text-[12px] text-ink-muted">If an issuer has paused one of these stocks, the batch above will fail on that leg. Take the others home now and come back for the paused one later.</p>
              {legsOnchain.map((l, i) => {
                const meta = view.legs.find((v) => v.token.toLowerCase() === l.token.toLowerCase());
                return (
                  <div key={l.token} className="flex items-center justify-between gap-3">
                    <span className="text-[13px]">
                      {meta?.underlying ?? shortenAddress(l.token)}
                      <span className="text-ink-muted font-mono num text-[12px]">
                        {" · "}
                        {formatTokenAmount(BigInt(meta?.scaledPerClaim ?? l.amountPerClaim) * BigInt(remaining), meta?.decimals ?? 8)} left
                      </span>
                    </span>
                    {l.withdrawn ? (
                      <Badge tone="positive">Withdrawn</Badge>
                    ) : (
                      <Button size="sm" variant="secondary" loading={busy === i} onClick={() => void withdrawLeg(i)}>
                        Withdraw
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {error && <ErrorBanner message={error.message} detail={error.detail} />}
          {tx && (
            <div className="text-[12px]">
              <TxLink hash={tx} />
            </div>
          )}
        </div>
      </Module>

      <Module>
        <ModuleHeader title={`Who claimed${counted > 0 ? ` · ${counted}` : ""}`} />
        {claims.isLoading ? (
          <div className="p-4 flex flex-col gap-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : rows.length === 0 ? (
          <p className="px-4 py-6 text-[14px] text-ink-secondary">Nobody has claimed yet. Share the link and this fills up.</p>
        ) : (
          <ul>
            {rows.map((c) => (
              <li key={c.claimant} className="flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0">
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium truncate">{c.basename ?? shortenAddress(c.claimant)}</span>
                  <span className="block text-[11px] text-ink-muted font-mono">
                    <TimeAgo value={c.createdAt} />
                  </span>
                  {(c.proof?.length ?? 0) > 0 && (
                    <span className="flex flex-wrap gap-1 mt-1">
                      {c.proof!.map((p) => (
                        <span
                          key={`${p.label}-${String(p.checked)}`}
                          className={cx(
                            "inline-block font-mono text-[10px] leading-none px-1.5 py-1 rounded-[4px]",
                            p.checked ? "bg-positive-soft text-positive-fg" : "bg-surface-muted text-ink-muted",
                          )}
                          title={p.checked ? "Read from Base" : "Declared by the claimant; X cannot be checked from outside"}
                        >
                          {p.checked ? p.label : `${p.label} · declared`}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <Badge tone={c.status === "reconciled" ? "positive" : c.status === "confirmed" ? "primary" : "neutral"}>
                  {c.status === "reconciled" ? "Onchain" : c.status === "confirmed" ? "Reported" : "Ticket issued"}
                </Badge>
                {c.txHash && <TxLink hash={c.txHash} />}
              </li>
            ))}
          </ul>
        )}
        <p className="px-4 py-3 text-[12px] text-ink-muted border-t border-line">
          “Onchain” rows were matched against a <span className="font-mono">PoolClaimed</span> log — those are proof. “Reported” is what a claim page told us and “Ticket issued” is a ticket nobody has used yet; neither counts as a claim. Sync reads the contract&apos;s logs and turns matches into Onchain rows. Green step tags were read from Base; grey “declared” tags are the claimant&apos;s own word about X, which nobody can check from outside.
        </p>
      </Module>
    </div>
  );
}
