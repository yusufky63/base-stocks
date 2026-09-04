"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContract, useWalletClient } from "wagmi";
import { encodeFunctionData, type Address, type Hash, type Hex } from "viem";
import { base } from "viem/chains";
import { Check, Circle, Gift, Lock, ShieldCheck, Sparkles, Users } from "lucide-react";
import type { PoolView, QuestStatus } from "@/domain/pool";
import { BASE_CHAIN_ID } from "@/config/chain";
import { publicEnv } from "@/config/env";
import { apiGet, apiPost, ApiError } from "@/lib/client-api";
import { attributionCapabilities, withAttribution } from "@/lib/attribution";
import { GIFT_POOL_ADDRESS, giftPoolAbi, isPoolDeployed, parsePoolFragment, signPoolTicket, type ClaimTicket } from "@/lib/pool";
import { humanizeError, type HumanError } from "@/lib/errors";
import { useAuth } from "@/hooks/useAuth";
import { useRegion } from "@/hooks/queries";
import { formatTokenAmount, formatUsd, shortenAddress } from "@/lib/format";
import { Badge, Button, LinkButton, Module, Skeleton } from "@/components/ui/primitives";
import { AddressLabel, AssetLogo, TxLink } from "@/components/common/display";
import { RegionNotice } from "@/components/common/RegionNotice";
import { ConnectButton } from "@/components/layout/ConnectButton";
import { PoolManagePanel } from "./PoolManagePanel";

type Phase = "idle" | "preparing" | "awaiting" | "submitted" | "confirmed" | "failed";

const PHASE_COPY: Record<Phase, string> = {
  idle: "",
  preparing: "Checking you are eligible…",
  awaiting: "Confirm in your wallet…",
  submitted: "Claiming onchain…",
  confirmed: "Claimed",
  failed: "Try again",
};

const subscribeNoop = () => () => {};

/**
 * The page behind a pool link. Onchain state is read straight from the contract and refreshed
 * while the page is open, so the share counter is the chain's, not the database's.
 *
 * Three claim paths share one transaction: an open pool needs nothing but the wallet, a link pool
 * signs a ticket in the browser with the key from the URL fragment (which never reaches a server),
 * and a quest pool asks BStocks for a ticket after verifying the tasks.
 */
export function PoolClaimView({ initialView }: { initialView: PoolView }) {
  const id = initialView.pool.id;
  const qc = useQueryClient();
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });
  const { isSignedIn, ensureSignedIn } = useAuth();
  const region = useRegion();

  const viewQ = useQuery({
    queryKey: ["pool", id],
    queryFn: () => apiGet<{ view: PoolView }>(`/api/pools/${id}`).then((r) => r.view),
    initialData: initialView,
    staleTime: 10_000,
  });
  const view = viewQ.data;
  const pool = view.pool;
  const onchainId = pool.onchainId as Hex;

  // Reads are pointless (and wagmi throws on an empty address) if this deployment has no contract.
  const deployed = isPoolDeployed();

  const hash = useSyncExternalStore(subscribeNoop, () => window.location.hash, () => "");
  const secret = useMemo(() => parsePoolFragment(hash), [hash]);
  const linkMatches = !!secret && secret.gateAddress.toLowerCase() === pool.gateAddress.toLowerCase();

  const chain = useReadContract({
    abi: giftPoolAbi,
    address: GIFT_POOL_ADDRESS as Address,
    functionName: "pools",
    args: [onchainId],
    chainId: BASE_CHAIN_ID,
    query: { enabled: deployed, refetchInterval: 10_000 },
  });
  const remaining = useReadContract({
    abi: giftPoolAbi,
    address: GIFT_POOL_ADDRESS as Address,
    functionName: "remainingSlots",
    args: [onchainId],
    chainId: BASE_CHAIN_ID,
    query: { enabled: deployed, refetchInterval: 10_000 },
  });
  const mine = useReadContract({
    abi: giftPoolAbi,
    address: GIFT_POOL_ADDRESS as Address,
    functionName: "hasClaimed",
    args: [onchainId, (address ?? "0x0000000000000000000000000000000000000000") as Address],
    chainId: BASE_CHAIN_ID,
    query: { enabled: deployed && !!address, refetchInterval: 15_000 },
  });

  const slots = chain.data ? Number(chain.data[2]) : pool.slots;
  const claimed = chain.data ? Number(chain.data[3]) : view.onchain?.claimed ?? 0;
  const cancelled = chain.data ? chain.data[6] : (view.onchain?.cancelled ?? false);
  const lockedUntil = chain.data ? Number(chain.data[5]) * 1000 : pool.lockedUntil;
  const remainingSlots = remaining.data !== undefined ? Number(remaining.data) : Math.max(0, slots - claimed);
  const alreadyMine = mine.data === true;
  const isCreator = !!address && address.toLowerCase() === pool.creator.toLowerCase();
  const [loadedAt] = useState(() => Date.now());
  const expired = loadedAt > pool.expiry;
  const restricted = region.data?.restricted === true;

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<HumanError | null>(null);
  const [claimTx, setClaimTx] = useState<Hash | undefined>();

  /* Quest checklist, only for quest-gated pools and only once signed in. */
  const questsQ = useQuery({
    queryKey: ["pool-quests", id, address ?? ""],
    queryFn: () => apiGet<{ quests: QuestStatus[]; eligible: boolean; alreadyClaimed: boolean }>(`/api/pools/${id}/ticket`),
    enabled: pool.gateMode === "signer" && isSignedIn && !!address,
    staleTime: 15_000,
  });

  const refresh = () => {
    void chain.refetch();
    void remaining.refetch();
    void mine.refetch();
    void qc.invalidateQueries({ queryKey: ["pool", id] });
    void qc.invalidateQueries({ queryKey: ["pool-quests", id] });
  };

  /** Produces the (deadline, v, r, s) the contract wants, per gate mode. */
  const buildTicket = async (recipient: Address): Promise<ClaimTicket> => {
    if (pool.gateMode === "open") return { deadline: "0", v: 0, r: `0x${"0".repeat(64)}`, s: `0x${"0".repeat(64)}` };
    if (pool.gateMode === "link") {
      if (!secret) throw new ApiError("BAD_REQUEST", "This link has no claim key. Open the full link you were sent.", 400);
      const deadline = BigInt(Math.min(Math.floor(pool.expiry / 1000), Math.floor(Date.now() / 1000) + 3600));
      return signPoolTicket(secret.privateKey, GIFT_POOL_ADDRESS as Address, onchainId, recipient, deadline);
    }
    await ensureSignedIn();
    const { ticket } = await apiPost<{ ticket: ClaimTicket }>(`/api/pools/${id}/ticket`, {});
    return ticket;
  };

  const claim = async () => {
    if (!address || !walletClient || !publicClient) return;
    if (chainId !== BASE_CHAIN_ID) {
      setError({ code: "WRONG_NETWORK", message: "Switch your wallet to Base to claim." });
      return;
    }
    setError(null);
    setPhase("preparing");
    try {
      const ticket = await buildTicket(address);
      const data = encodeFunctionData({
        abi: giftPoolAbi,
        functionName: "claim",
        args: [onchainId, address, BigInt(ticket.deadline), ticket.v, ticket.r, ticket.s],
      });

      let atomic = false;
      let paymaster = false;
      try {
        const caps = (await walletClient.getCapabilities({ account: address, chainId: BASE_CHAIN_ID })) as { atomic?: { status?: string }; paymasterService?: { supported?: boolean } };
        atomic = caps.atomic?.status === "supported" || caps.atomic?.status === "ready";
        paymaster = !!publicEnv.paymasterUrl && !!caps.paymasterService?.supported;
      } catch {
        atomic = false;
      }

      setPhase("awaiting");
      let hash: Hash | undefined;
      if (atomic) {
        const { id: callsId } = await walletClient.sendCalls({
          account: address,
          chain: base,
          calls: [{ to: GIFT_POOL_ADDRESS as Address, data: withAttribution(data) }],
          capabilities: { ...attributionCapabilities(), ...(paymaster ? { paymasterService: { url: publicEnv.paymasterUrl } } : {}) },
        });
        setPhase("submitted");
        const result = await walletClient.waitForCallsStatus({ id: callsId, timeout: 180_000 });
        if (result.status === "failure") throw new Error("The claim transaction failed onchain.");
        hash = result.receipts?.[result.receipts.length - 1]?.transactionHash;
      } else {
        await publicClient.call({ account: address, to: GIFT_POOL_ADDRESS as Address, data });
        hash = await walletClient.sendTransaction({ account: address, chain: base, to: GIFT_POOL_ADDRESS as Address, data: withAttribution(data) });
        setPhase("submitted");
        await publicClient.waitForTransactionReceipt({ hash });
      }

      setClaimTx(hash);
      if (hash) void apiPost(`/api/pools/${id}/claims`, { claimant: address, txHash: hash }).catch(() => undefined);
      setPhase("confirmed");
      refresh();
    } catch (err) {
      const h = err instanceof ApiError ? { code: "UNKNOWN" as const, message: err.message } : humanizeError(err);
      if (/insufficient funds/i.test(("detail" in h && h.detail) || "")) {
        h.message = "This wallet has no ETH for gas. Claim with a Base Account (passkey) instead — the fee is covered for you.";
      }
      setError(h);
      setPhase("failed");
    }
  };

  const shareLabel = view.legs.map((l) => `${formatTokenAmount(BigInt(l.scaledPerClaim), l.decimals)} ${l.underlying}`).join(" + ");
  const claimedView = phase === "confirmed" || alreadyMine;
  const busy = phase === "preparing" || phase === "awaiting" || phase === "submitted";
  const soldOut = remainingSlots === 0 && !cancelled && !expired;
  const questsBlocked = pool.gateMode === "signer" && isSignedIn && questsQ.data ? !questsQ.data.eligible : false;

  return (
    <div className="mx-auto w-full max-w-[600px] flex flex-col gap-5">
      <Module ticks>
        <div className="p-6 flex flex-col items-center text-center gap-3">
          <div className="flex items-center justify-center -space-x-3">
            {view.legs.length === 0 ? (
              <span className="w-20 h-20 rounded-full bg-primary-soft inline-flex items-center justify-center">
                <Gift size={34} strokeWidth={1.5} className="text-primary" />
              </span>
            ) : (
              view.legs.map((l) => (
                <span key={l.token} className="rounded-full ring-2 ring-canvas">
                  <AssetLogo src={l.logoURI} symbol={l.underlying} size={56} />
                </span>
              ))
            )}
          </div>
          <div className="eyebrow">{pool.title || (view.legs.length > 1 ? "A stock package for you" : "A share of stock for you")}</div>
          <h1 className="display text-[34px] leading-[1.05]">{shareLabel || "A tokenized stock"}</h1>
          <p className="text-[13px] text-ink-secondary">
            {view.usdPerClaim !== null ? `About ${formatUsd(view.usdPerClaim)} per person · ` : ""}
            Coinbase Tokenized Stocks on Base
          </p>
          {pool.message && <blockquote className="mt-1 border-l-2 border-primary pl-3 text-[15px] text-ink text-left max-w-[42ch]">{pool.message}</blockquote>}

          <div className="flex items-center gap-2 flex-wrap justify-center mt-1">
            {claimedView && <Badge tone="positive">You claimed yours</Badge>}
            {cancelled && <Badge>Closed by the creator</Badge>}
            {!cancelled && expired && <Badge tone="warning">Claim window closed</Badge>}
            {!cancelled && !expired && soldOut && <Badge tone="warning">All shares taken</Badge>}
            {!cancelled && !expired && !soldOut && (
              <Badge tone="primary">
                <span className="inline-flex items-center gap-1.5">
                  <Users size={12} strokeWidth={2} /> {`${remainingSlots} of ${slots} left`}
                </span>
              </Badge>
            )}
            {lockedUntil > loadedAt && (
              <Badge>
                <span className="inline-flex items-center gap-1.5">
                  <Lock size={12} strokeWidth={2} /> {`Locked until ${new Date(lockedUntil).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`}
                </span>
              </Badge>
            )}
          </div>
        </div>

        {view.legs.length > 1 && (
          <ul className="border-t border-line">
            {view.legs.map((l) => (
              <li key={l.token} className="flex items-center gap-3 px-5 py-2.5 border-b border-line last:border-b-0">
                <AssetLogo src={l.logoURI} symbol={l.underlying} size={26} />
                <span className="flex-1 text-[13px] font-medium">{l.underlying}</span>
                <span className="font-mono num text-[13px] text-ink-secondary">
                  {formatTokenAmount(BigInt(l.scaledPerClaim), l.decimals)}
                  {l.usdPerClaim !== null ? ` · ${formatUsd(l.usdPerClaim)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-line p-5 flex flex-col gap-3">
          {claimedView ? (
            <>
              <p className="text-[14px] text-ink-secondary text-center">
                {phase === "confirmed" ? "Your share is in your wallet. It stays yours, self-custodial, on Base." : "This wallet already took its share of this pool."}
              </p>
              {claimTx && (
                <div className="text-center">
                  <TxLink hash={claimTx} />
                </div>
              )}
              <div className="flex gap-2">
                <LinkButton href="/portfolio" variant="primary" full>
                  View your portfolio
                </LinkButton>
                {view.legs[0] && (
                  <LinkButton href={`/stocks/${view.legs[0].token}`} full>
                    {`About ${view.legs[0].underlying}`}
                  </LinkButton>
                )}
              </div>
            </>
          ) : cancelled ? (
            <p className="text-[14px] text-ink-secondary text-center">The creator closed this pool and took the remainder back.</p>
          ) : expired ? (
            <p className="text-[14px] text-ink-secondary text-center">The claim window has closed. Only the creator can withdraw what is left.</p>
          ) : soldOut ? (
            <p className="text-[14px] text-ink-secondary text-center">Every share has been claimed. Nothing left in this one.</p>
          ) : restricted ? (
            <RegionNotice region={region.data!} />
          ) : pool.gateMode === "link" && !secret ? (
            <p className="text-[14px] text-ink-secondary text-center">
              This preview has no claim key. Open the full link you received — the part after # is the key, and it never leaves your device.
            </p>
          ) : pool.gateMode === "link" && !linkMatches ? (
            <p className="text-[14px] text-danger-fg text-center">This link does not match the pool. Ask whoever shared it to send it again.</p>
          ) : !isConnected ? (
            <>
              <ConnectButton full size="lg" />
              <p className="text-[12px] text-ink-muted text-center flex items-center justify-center gap-1.5">
                <Sparkles size={13} strokeWidth={1.75} className="text-primary" /> New to this? Pick Base Account: a wallet from your fingerprint, ready in seconds, claim fee covered.
              </p>
            </>
          ) : (
            <>
              {pool.gateMode === "signer" && <QuestChecklist id={id} isSignedIn={isSignedIn} data={questsQ.data} loading={questsQ.isLoading} onSignIn={() => void ensureSignedIn().then(refresh)} />}
              <Button full size="lg" loading={busy} disabled={questsBlocked} onClick={() => void claim()}>
                {busy ? PHASE_COPY[phase] : `Claim ${shareLabel || "your share"}`}
              </Button>
              <p className="text-[12px] text-ink-muted text-center">{`Goes to ${shortenAddress(address as Address)} — your wallet, your keys. One share per wallet.`}</p>
            </>
          )}
          {error && <p className="text-[13px] text-danger-fg text-center">{error.message}</p>}
        </div>
      </Module>

      <div className="flex items-center justify-center gap-2 text-[12px] text-ink-muted">
        <ShieldCheck size={14} strokeWidth={1.75} />
        <span>
          Held by an ownerless pool contract on Base:&nbsp;
          <AddressLabel address={GIFT_POOL_ADDRESS as Address} showCopy={false} explorer />
        </span>
      </div>

      {isCreator && <PoolManagePanel view={view} onChanged={refresh} lockedUntil={lockedUntil} cancelled={cancelled} claimed={claimed} slots={slots} />}

      <p className="text-[11px] text-ink-muted text-center">
        Coinbase Tokenized Stocks are for eligible persons outside the United States. Not investment advice.{" "}
        <Link href="/how-it-works" className="text-primary">
          How BStocks works →
        </Link>
      </p>
    </div>
  );
}

/* ----------------------------- quest checklist ---------------------------- */

function QuestChecklist({
  id,
  isSignedIn,
  data,
  loading,
  onSignIn,
}: {
  id: string;
  isSignedIn: boolean;
  data?: { quests: QuestStatus[]; eligible: boolean; alreadyClaimed: boolean };
  loading: boolean;
  onSignIn: () => void;
}) {
  if (!isSignedIn) {
    return (
      <div className="border border-line rounded-[8px] p-4 flex flex-col gap-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">This pool has requirements</span>
        <p className="text-[13px] text-ink-secondary">Sign in with your wallet so we can check them. It is one signature, costs nothing and approves no transaction.</p>
        <Button size="sm" onClick={onSignIn}>
          Sign in to check
        </Button>
      </div>
    );
  }
  if (loading || !data) return <Skeleton className="h-20" />;
  return (
    <ul className="border border-line rounded-[8px] overflow-hidden" data-pool={id}>
      {data.quests.map((q) => (
        <li key={q.type} className="flex items-start gap-2.5 px-3.5 py-2.5 border-b border-line last:border-b-0">
          {q.done ? <Check size={15} strokeWidth={2.5} className="text-positive-fg mt-0.5 shrink-0" /> : <Circle size={15} strokeWidth={1.75} className="text-ink-muted mt-0.5 shrink-0" />}
          <span className="min-w-0">
            <span className={`block text-[13px] ${q.done ? "text-ink-secondary line-through" : "font-medium"}`}>{q.label}</span>
            {!q.done && q.detail && <span className="block text-[12px] text-ink-muted">{q.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
