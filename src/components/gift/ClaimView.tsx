"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContract, useWalletClient } from "wagmi";
import { encodeFunctionData, type Address, type Hash, type Hex } from "viem";
import { base } from "viem/chains";
import { Gift, ShieldCheck, Sparkles } from "lucide-react";
import type { GiftReceipt } from "@/services/gift-service";
import { giftAmountLabel, giftPartyLabel } from "@/services/gift-service";
import { BASE_CHAIN_ID } from "@/config/chain";
import { publicEnv } from "@/config/env";
import { apiGet, apiPatch } from "@/lib/client-api";
import { attributionCapabilities, withAttribution } from "@/lib/attribution";
import { GIFT_ESCROW_ADDRESS, giftEscrowAbi, parseClaimFragment, signClaim } from "@/lib/escrow";
import { humanizeError, type HumanError } from "@/lib/errors";
import { coinSrc } from "@/lib/coins";
import { shortenAddress } from "@/lib/format";
import { useRegion } from "@/hooks/queries";
import { Badge, Button, LinkButton, Module } from "@/components/ui/primitives";
import { AddressLabel, TxLink } from "@/components/common/display";
import { ShareActions } from "@/components/common/ShareSheet";
import { Avatar } from "@/components/common/RecipientCard";
import { RegionNotice } from "@/components/common/RegionNotice";
import { ConnectButton } from "@/components/layout/ConnectButton";

const ZERO = "0x0000000000000000000000000000000000000000";

type ClaimPhase = "idle" | "signing" | "awaiting" | "submitted" | "confirmed" | "failed";

const subscribeNoop = () => () => {};

/**
 * The page behind a claim link. The URL fragment carries the ephemeral claim key (never sent to
 * the server); the escrow state is read straight from the chain. Claiming needs any wallet — a
 * fresh passkey Base Account is the featured path, and the transaction is sponsored where the
 * paymaster allows.
 */
export function ClaimView({ initialReceipt }: { initialReceipt: GiftReceipt }) {
  const id = initialReceipt.gift.id;
  const qc = useQueryClient();
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });
  const region = useRegion();

  const receiptQ = useQuery({
    queryKey: ["gift-receipt", id],
    queryFn: () => apiGet<{ receipt: GiftReceipt }>(`/api/gifts/${id}`).then((r) => r.receipt),
    initialData: initialReceipt,
    staleTime: 10_000,
  });
  const r = receiptQ.data;
  const gift = r.gift;
  const escrowId = (gift.escrowId ?? "0x") as Hex;

  const hash = useSyncExternalStore(subscribeNoop, () => window.location.hash, () => "");
  const secret = useMemo(() => parseClaimFragment(hash), [hash]);
  const secretMatches = !!secret && secret.escrowId.toLowerCase() === escrowId.toLowerCase();

  const onchain = useReadContract({
    abi: giftEscrowAbi,
    address: GIFT_ESCROW_ADDRESS,
    functionName: "gifts",
    args: [escrowId],
    chainId: BASE_CHAIN_ID,
    query: { enabled: gift.escrowId !== undefined, refetchInterval: 8_000 },
  });
  const onchainSender = onchain.data?.[0] ?? null;
  const active = onchainSender !== null && onchainSender !== ZERO;
  const isSender = !!address && address.toLowerCase() === gift.sender.toLowerCase();

  const [phase, setPhase] = useState<ClaimPhase>("idle");
  const [loadedAt] = useState(() => Date.now());
  const expired = gift.expiresAt !== undefined && loadedAt > gift.expiresAt;
  const [error, setError] = useState<HumanError | null>(null);
  const [claimTx, setClaimTx] = useState<Hash | undefined>();
  const [cancelBusy, setCancelBusy] = useState(false);

  const amount = giftAmountLabel(r);
  const senderName = giftPartyLabel(r.sender);
  const coin = coinSrc(r.asset?.underlying, "full");
  const restricted = region.data?.restricted === true;

  const refresh = () => {
    void onchain.refetch();
    void qc.invalidateQueries({ queryKey: ["gift-receipt", id] });
  };

  const claim = async () => {
    if (!address || !walletClient || !publicClient || !secret) return;
    if (chainId !== BASE_CHAIN_ID) {
      setError({ code: "WRONG_NETWORK", message: "Switch your wallet to Base to claim." });
      return;
    }
    setError(null);
    setPhase("signing");
    try {
      const sig = await signClaim(secret.privateKey, escrowId, address);
      const data = encodeFunctionData({ abi: giftEscrowAbi, functionName: "claim", args: [escrowId, address, sig.v, sig.r, sig.s] });
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
          calls: [{ to: GIFT_ESCROW_ADDRESS, data: withAttribution(data) }],
          capabilities: { ...attributionCapabilities(), ...(paymaster ? { paymasterService: { url: publicEnv.paymasterUrl } } : {}) },
        });
        setPhase("submitted");
        const result = await walletClient.waitForCallsStatus({ id: callsId, timeout: 180_000 });
        if (result.status === "failure") throw new Error("The claim transaction failed onchain.");
        hash = result.receipts?.[result.receipts.length - 1]?.transactionHash;
      } else {
        await publicClient.call({ account: address, to: GIFT_ESCROW_ADDRESS, data });
        hash = await walletClient.sendTransaction({ account: address, chain: base, to: GIFT_ESCROW_ADDRESS, data: withAttribution(data) });
        setPhase("submitted");
        await publicClient.waitForTransactionReceipt({ hash });
      }
      setClaimTx(hash);
      await apiPatch(`/api/gifts/${id}`, { status: "claimed", claimTx: hash, claimedBy: address }).catch(() => undefined);
      setPhase("confirmed");
      refresh();
    } catch (err) {
      const h = humanizeError(err);
      if (/insufficient funds/i.test(h.detail ?? "")) h.message = "This wallet has no ETH for gas. Claim with a Base Account (passkey) instead — the fee is covered for you.";
      setError(h);
      setPhase("failed");
    }
  };

  const cancel = async () => {
    if (!address || !walletClient || !publicClient) return;
    setCancelBusy(true);
    setError(null);
    try {
      const data = encodeFunctionData({ abi: giftEscrowAbi, functionName: "reclaim", args: [escrowId] });
      await publicClient.call({ account: address, to: GIFT_ESCROW_ADDRESS, data });
      const hash = await walletClient.sendTransaction({ account: address, chain: base, to: GIFT_ESCROW_ADDRESS, data: withAttribution(data) });
      await publicClient.waitForTransactionReceipt({ hash });
      await apiPatch(`/api/gifts/${id}`, { status: "reclaimed", claimTx: hash }).catch(() => undefined);
      refresh();
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setCancelBusy(false);
    }
  };

  const claimedView = phase === "confirmed" || (!active && (gift.status === "claimed" || (gift.recipient !== ZERO && gift.claimTx)));
  const reclaimedView = phase !== "confirmed" && !active && gift.status === "reclaimed";
  const settling = !claimedView && !reclaimedView && !active && onchain.isFetched && !onchain.isError;
  const busy = phase === "signing" || phase === "awaiting" || phase === "submitted";

  return (
    <div className="mx-auto w-full max-w-[560px] flex flex-col gap-5">
      <Module ticks>
        <div className="p-6 flex flex-col items-center text-center gap-3">
          {coin ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={coin} alt="" width={128} height={128} className="w-32 h-32 drop-shadow-[0_12px_24px_rgba(3,112,253,0.25)]" />
          ) : (
            <span className="w-24 h-24 rounded-full bg-primary-soft inline-flex items-center justify-center">
              <Gift size={40} strokeWidth={1.5} className="text-primary" />
            </span>
          )}
          <div className="eyebrow flex items-center gap-2">
            <Avatar src={r.sender.avatar} seed={gift.sender} label={senderName} size={20} /> {`${senderName} sent you`}
          </div>
          <h1 className="display text-[40px] leading-[1.02]">{amount}</h1>
          <p className="text-[13px] text-ink-secondary">{r.asset ? `${r.asset.name} · a Coinbase Tokenized Stock on Base` : "A Coinbase Tokenized Stock on Base"}</p>
          {gift.message && <blockquote className="mt-1 border-l-2 border-primary pl-3 text-[15px] text-ink text-left max-w-[40ch]">{gift.message}</blockquote>}
          <div className="flex items-center gap-2 mt-1">
            {claimedView && <Badge tone="positive">Claimed</Badge>}
            {reclaimedView && <Badge>Cancelled by sender</Badge>}
            {active && expired && <Badge tone="warning">Expired</Badge>}
            {active && !expired && gift.expiresAt !== undefined && <Badge>{`Claimable until ${new Date(gift.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`}</Badge>}
          </div>
        </div>

        <div className="border-t border-line p-5 flex flex-col gap-3">
          {claimedView ? (
            <>
              <p className="text-[14px] text-ink-secondary text-center">
                {phase === "confirmed" ? "The stock is in your wallet. It stays yours, self-custodial, on Base." : `Claimed by ${shortenAddress((gift.recipient !== ZERO ? gift.recipient : address) ?? ZERO)}.`}
              </p>
              {(claimTx ?? gift.claimTx) && (
                <div className="text-center">
                  <TxLink hash={(claimTx ?? gift.claimTx)!} />
                </div>
              )}
              {phase === "confirmed" && (
                <div className="flex gap-2">
                  <LinkButton href="/portfolio" variant="primary" full>
                    View your portfolio
                  </LinkButton>
                  {r.asset && (
                    <LinkButton href={`/stocks/${r.asset.address}`} full>
                      {`About ${r.asset.underlying}`}
                    </LinkButton>
                  )}
                </div>
              )}
              {/* The claim link itself is single-use and unlisted, so what gets shared is the stock. */}
              {phase === "confirmed" && r.asset && (
                <ShareActions
                  compact
                  className="pt-1"
                  path={`/stocks/${r.asset.address}`}
                  text={`Someone gifted me ${amount} on BaseStocks — a tokenized stock on Base.`}
                />
              )}
            </>
          ) : reclaimedView ? (
            <p className="text-[14px] text-ink-secondary text-center">The sender took this gift back. Ask them for a new link.</p>
          ) : settling ? (
            <p className="text-[14px] text-ink-secondary text-center">Settling onchain…</p>
          ) : restricted ? (
            <RegionNotice region={region.data!} />
          ) : !secret ? (
            <p className="text-[14px] text-ink-secondary text-center">This preview has no claim key. Open the full link you received — the part after # is the key and never leaves your device.</p>
          ) : !secretMatches ? (
            <p className="text-[14px] text-danger-fg text-center">This link does not match the gift. Ask the sender to share it again.</p>
          ) : expired ? (
            <p className="text-[14px] text-ink-secondary text-center">The claim window has closed; only the sender can withdraw it now.</p>
          ) : !isConnected ? (
            <>
              <ConnectButton full size="lg" />
              <p className="text-[12px] text-ink-muted text-center flex items-center justify-center gap-1.5">
                <Sparkles size={13} strokeWidth={1.75} className="text-primary" /> New to this? Pick Base Account: a wallet from your fingerprint, ready in seconds, claim fee covered.
              </p>
            </>
          ) : (
            <>
              <Button full size="lg" loading={busy} onClick={() => void claim()}>
                {busy ? PHASE_COPY[phase] : `Claim ${amount}`}
              </Button>
              <p className="text-[12px] text-ink-muted text-center">{`Goes to ${shortenAddress(address as Address)} — your wallet, your keys.`}</p>
            </>
          )}
          {error && <p className="text-[13px] text-danger-fg text-center">{error.message}</p>}
        </div>
      </Module>

      <div className="flex items-center justify-center gap-2 text-[12px] text-ink-muted">
        <ShieldCheck size={14} strokeWidth={1.75} />
        <span>
          Held by an ownerless escrow contract on Base:&nbsp;
          <AddressLabel address={GIFT_ESCROW_ADDRESS} showCopy={false} explorer />
        </span>
      </div>

      {isSender && active && (
        <Module>
          <div className="p-4 flex items-center justify-between gap-3">
            <div>
              <div className="text-[14px] font-medium">Your gift</div>
              <div className="text-[12px] text-ink-muted">Cancel to bring the stock straight back to your wallet. The link stops working.</div>
            </div>
            <Button variant="danger" size="sm" loading={cancelBusy} onClick={() => void cancel()}>
              Cancel gift
            </Button>
          </div>
        </Module>
      )}

      <p className="text-[11px] text-ink-muted text-center">
        Coinbase Tokenized Stocks are for eligible persons outside the United States. Not investment advice.{" "}
        <Link href="/how-it-works" className="text-primary">
          How BaseStocks works →
        </Link>
      </p>
    </div>
  );
}

const PHASE_COPY: Record<ClaimPhase, string> = {
  idle: "",
  signing: "Preparing your claim…",
  awaiting: "Confirm in your wallet…",
  submitted: "Claiming onchain…",
  confirmed: "Claimed",
  failed: "Try again",
};
