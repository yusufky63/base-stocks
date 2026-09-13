"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContracts, useWalletClient } from "wagmi";
import { encodeFunctionData, type Address, type Hash, type Hex } from "viem";
import { Gift, Lock, ShieldCheck, Sparkles, Users } from "lucide-react";
import type { PoolView, QuestStatus } from "@/domain/pool";
import { BASE_CHAIN_ID } from "@/config/chain";
import { apiGet, apiPost, ApiError } from "@/lib/client-api";
import { GIFT_POOL_ADDRESS, giftPoolAbi, isPoolDeployed, parsePoolFragment, signPoolTicket, type ClaimTicket } from "@/lib/pool";
import { postWithRetry } from "@/lib/gift/record";
import { explainClaimError, pollWhenVisible, probeWalletCapabilities, sendCallsOrSequential } from "@/lib/gift/wallet";
import { type HumanError } from "@/lib/errors";
import { useAuth } from "@/hooks/useAuth";
import { useNow } from "@/hooks/useNow";
import { useRegion } from "@/hooks/queries";
import { formatTokenAmount, formatUsd, shortenAddress } from "@/lib/format";
import { Badge, Button, LinkButton, Module } from "@/components/ui/primitives";
import { AddressLabel, AssetLogo, TxLink } from "@/components/common/display";
import { RegionNotice } from "@/components/common/RegionNotice";
import { ConnectButton } from "@/components/layout/ConnectButton";
import { ShareActions } from "@/components/common/ShareSheet";
import { PoolManagePanel } from "./PoolManagePanel";
import { QuestChecklist } from "./QuestChecklist";

type Phase = "idle" | "preparing" | "awaiting" | "submitted" | "confirmed" | "failed";

const PHASE_COPY: Record<Phase, string> = {
  idle: "",
  preparing: "Checking you are eligible…",
  awaiting: "Confirm in your wallet…",
  submitted: "Claiming onchain…",
  confirmed: "Claimed",
  failed: "Try again",
};

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const subscribeNoop = () => () => {};

/**
 * The page behind a pool link. Onchain state is read straight from the contract and refreshed
 * while the page is open, so the share counter is the chain's, not the database's.
 *
 * Three claim paths share one transaction: an open pool needs nothing but the wallet, a link pool
 * signs a ticket in the browser with the key from the URL fragment (which never reaches a server),
 * and a quest pool asks BaseStocks for a ticket after verifying the tasks.
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

  // The three reads this page needs, as one multicall, paused while the tab is hidden. Three
  // separate polls used to cost three round trips every ten seconds, in a background tab too.
  const contract = { abi: giftPoolAbi, address: GIFT_POOL_ADDRESS as Address, chainId: BASE_CHAIN_ID } as const;
  const chain = useReadContracts({
    contracts: [
      { ...contract, functionName: "pools", args: [onchainId] },
      { ...contract, functionName: "remainingSlots", args: [onchainId] },
      { ...contract, functionName: "hasClaimed", args: [onchainId, address ?? ZERO] },
    ],
    allowFailure: true,
    query: { enabled: deployed, refetchInterval: pollWhenVisible(15_000) },
  });
  const poolData = chain.data?.[0]?.status === "success" ? chain.data[0].result : undefined;
  const remainingData = chain.data?.[1]?.status === "success" ? chain.data[1].result : undefined;
  const mineData = !!address && chain.data?.[2]?.status === "success" ? chain.data[2].result : undefined;

  const slots = poolData ? Number(poolData[2]) : pool.slots;
  const claimed = poolData ? Number(poolData[3]) : (view.onchain?.claimed ?? 0);
  const cancelled = poolData ? poolData[6] : (view.onchain?.cancelled ?? false);
  const lockedUntil = poolData ? Number(poolData[5]) * 1000 : pool.lockedUntil;
  const expiry = poolData ? Number(poolData[4]) * 1000 : pool.expiry;
  const remainingSlots = remainingData !== undefined ? Number(remainingData) : Math.max(0, slots - claimed);
  const alreadyMine = mineData === true;
  const isCreator = !!address && address.toLowerCase() === pool.creator.toLowerCase();
  // A ticking clock: a window that closes while the page is open should say so.
  const now = useNow(30_000);
  const expired = now > 0 && now > expiry;
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
    void qc.invalidateQueries({ queryKey: ["pool", id] });
    void qc.invalidateQueries({ queryKey: ["pool-quests", id] });
  };

  /** Produces the (deadline, v, r, s) the contract wants, per gate mode. */
  const buildTicket = async (recipient: Address): Promise<ClaimTicket> => {
    if (pool.gateMode === "open") return { deadline: "0", v: 0, r: `0x${"0".repeat(64)}`, s: `0x${"0".repeat(64)}` };
    if (pool.gateMode === "link") {
      if (!secret) throw new ApiError("BAD_REQUEST", "This link has no claim key. Open the full link you were sent.", 400);
      const deadline = BigInt(Math.min(Math.floor(expiry / 1000), Math.floor(Date.now() / 1000) + 3600));
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
      const caps = await probeWalletCapabilities(walletClient, address);
      setPhase("awaiting");
      // Gas is sponsored only where a gate already limits who can claim. On an open pool a free
      // claim is a free sybil: one passkey per share, at nobody's expense but the sponsor's.
      const { last: hash } = await sendCallsOrSequential({
        walletClient,
        publicClient,
        address,
        caps,
        sponsor: pool.gateMode !== "open",
        calls: [{ to: GIFT_POOL_ADDRESS as Address, data }],
        preflight: () => publicClient.call({ account: address, to: GIFT_POOL_ADDRESS as Address, data }).then(() => undefined),
        onSubmitted: () => setPhase("submitted"),
      });
      setClaimTx(hash);
      // The report is what lets the creator's roster and the claimant's timeline show this share; written, with retries.
      if (hash) await postWithRetry(`/api/pools/${id}/claims`, { claimant: address, txHash: hash });
      setPhase("confirmed");
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? { code: "UNKNOWN", message: err.message } : explainClaimError(err));
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
            {now > 0 && lockedUntil > now && (
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
              {/* The moment worth sharing. A link-gated pool's URL is useless without the key it
                  carries in the fragment, so those point at the stock instead of a dead claim page. */}
              <ShareActions
                compact
                className="pt-1"
                path={pool.gateMode === "link" && view.legs[0] ? `/stocks/${view.legs[0].token}` : `/pools/${pool.id}`}
                text={`I claimed ${shareLabel || "a share"} from a gift pool on BaseStocks — tokenized stocks on Base.`}
              />
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
                <Sparkles size={13} strokeWidth={1.75} className="text-primary" />{" "}
                {pool.gateMode === "open" ? "New to this? Pick Base Account: a wallet from your fingerprint, ready in seconds." : "New to this? Pick Base Account: a wallet from your fingerprint, ready in seconds, claim fee covered."}
              </p>
            </>
          ) : (
            <>
              {pool.gateMode === "signer" && (
                <QuestChecklist
                  poolId={id}
                  isSignedIn={isSignedIn}
                  data={questsQ.data}
                  loading={questsQ.isLoading}
                  onSignIn={() => void ensureSignedIn().then(refresh)}
                  onChanged={() => void questsQ.refetch()}
                />
              )}
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

      {isCreator && <PoolManagePanel view={view} onChanged={refresh} lockedUntil={lockedUntil} cancelled={cancelled} claimed={claimed} slots={slots} expiry={expiry} />}

      <p className="text-[11px] text-ink-muted text-center">
        Coinbase Tokenized Stocks are for eligible persons outside the United States. Not investment advice.{" "}
        <Link href="/how-it-works" className="text-primary">
          How BaseStocks works →
        </Link>
      </p>
    </div>
  );
}
