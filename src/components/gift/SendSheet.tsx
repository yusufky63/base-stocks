"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { encodeFunctionData, formatUnits, type Address, type Hash } from "viem";
import { base } from "viem/chains";
import type { B20AssetDTO } from "@/domain/asset";
import type { GiftRecord } from "@/domain/gift";
import type { TradeState } from "@/domain/trade";
import { b20AssetAbi } from "@/lib/b20/abi";
import { toRaw, parseAmountSafe, bpsOf } from "@/lib/b20/math";
import { withAttribution } from "@/lib/attribution";
import { apiPost, ApiError } from "@/lib/client-api";
import { patchWithRetry } from "@/lib/gift/record";
import { humanizeError, TRADE_ERROR_COPY, type HumanError } from "@/lib/errors";
import { formatTokenAmount, formatUsd, shortenAddress } from "@/lib/format";
import { useAuth } from "@/hooks/useAuth";
import { useResolveRecipient, useTxStatus } from "@/hooks/queries";
import { BASE_CHAIN_ID } from "@/config/chain";
import { Sheet } from "@/components/ui/Sheet";
import { Input, AmountInput } from "@/components/ui/Input";
import { Button, Chip, KeyValue } from "@/components/ui/primitives";
import { AddressLabel, ErrorBanner, InfoBanner } from "@/components/common/display";
import { RecipientCard } from "@/components/common/RecipientCard";
import { ShareButton } from "@/components/common/ShareSheet";
import { TxProgress } from "@/components/trade/TxProgress";
import { Segmented } from "@/components/ui/Segmented";
import { ClaimLinkFlow } from "./ClaimLinkFlow";

interface Props {
  open: boolean;
  onClose: () => void;
  asset: B20AssetDTO;
  raw: bigint;
  scaled: bigint;
  priceUsd: number | null;
  onSent?: () => void;
}

type Step = "form" | "review";

/**
 * Send / Gift an existing position (spec §4.6, §22, §27):
 * resolve recipient (Basename or address) → B20 guard (server) → transferWithMemo(bytes32) → activity record.
 * The review screen always shows the currently resolved address.
 */
export function SendSheet({ open, onClose, asset, raw, scaled, priceUsd, onSent }: Props) {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });
  const { ensureSignedIn } = useAuth();
  const [step, setStep] = useState<Step>("form");
  const [mode, setMode] = useState<"direct" | "link">("direct");
  const [recipientInput, setRecipientInput] = useState("");
  const [shares, setShares] = useState("");
  const [message, setMessage] = useState("");
  const [gift, setGift] = useState<GiftRecord | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [localError, setLocalError] = useState<HumanError | null>(null);
  const [machine, setMachine] = useState<TradeState>("IDLE");
  const [txHash, setTxHash] = useState<Hash | undefined>();
  const [busyPreview, setBusyPreview] = useState(false);
  const reported = useRef<string | null>(null);
  const status = useTxStatus(txHash);
  const resolve = useResolveRecipient(recipientInput);
  const resolved = resolve.data?.resolved ?? null;

  const multiplier = BigInt(asset.multiplier);
  const wad = BigInt(asset.wadPrecision);
  const rawAmount = useMemo(() => {
    const s = parseAmountSafe(shares, asset.decimals);
    if (s === 0n) return 0n;
    const r = toRaw(s, multiplier, wad);
    return r > raw ? raw : r;
  }, [shares, asset.decimals, multiplier, wad, raw]);
  const valueUsd = priceUsd !== null ? Number(formatUnits(rawAmount, asset.decimals)) * priceUsd : null;

  // Derived chain state.
  const chain = txHash ? status.data?.status : undefined;
  let txState: TradeState = machine;
  let error = localError;
  if (machine === "SUBMITTED" || machine === "PRECONFIRMED") {
    if (chain === "preconfirmed") txState = "PRECONFIRMED";
    else if (chain === "confirmed") txState = "CONFIRMED";
    else if (chain === "failed") {
      txState = "FAILED";
      error = { code: "SIMULATION_FAILED", message: "The transfer reverted onchain. Nothing was sent." };
    }
  }

  useEffect(() => {
    if (!gift || !txHash || !chain) return;
    if ((chain === "confirmed" || chain === "failed") && reported.current !== `${txHash}:${chain}`) {
      reported.current = `${txHash}:${chain}`;
      // The hash rides along: if the first write was lost, this one still names the transaction.
      void patchWithRetry(`/api/gifts/${gift.id}`, { txHash, status: chain });
      if (chain === "confirmed") onSent?.();
    }
  }, [chain, txHash, gift, onSent]);

  const resetAll = () => {
    setStep("form");
    setGift(null);
    setLocalError(null);
    setMachine("IDLE");
    setTxHash(undefined);
    setWarnings([]);
    reported.current = null;
  };
  const handleClose = () => {
    resetAll();
    onClose();
  };

  const setPct = (pct: number) => setShares(formatUnits((bpsOf(raw, pct * 100) * multiplier) / wad, asset.decimals));

  const toReview = async () => {
    setLocalError(null);
    if (!address) return;
    if (!resolved) {
      setLocalError({ code: "UNKNOWN", message: "Enter a valid Basename (alice.base.eth) or a 0x address." });
      return;
    }
    if (rawAmount === 0n) {
      setLocalError({ code: "AMOUNT_TOO_SMALL", message: "Enter an amount to send." });
      return;
    }
    setBusyPreview(true);
    try {
      // The draft is written under this wallet, so the wallet proves it is the one asking.
      await ensureSignedIn();
      const res = await apiPost<{ gift: GiftRecord; warnings: string[] }>("/api/gifts", {
        kind: "send-existing",
        sender: address,
        recipient: recipientInput.trim(),
        assetAddress: asset.address,
        rawAmount: rawAmount.toString(),
        message: message.trim() || undefined,
      });
      setGift(res.gift);
      setWarnings(res.warnings);
      setStep("review");
    } catch (err) {
      setLocalError(err instanceof ApiError ? { code: (err.code in TRADE_ERROR_COPY ? err.code : "UNKNOWN") as HumanError["code"], message: err.message } : humanizeError(err));
    } finally {
      setBusyPreview(false);
    }
  };

  const send = async () => {
    if (!gift || !walletClient || !publicClient || !address) return;
    if (chainId !== BASE_CHAIN_ID) {
      setLocalError({ code: "WRONG_NETWORK", message: TRADE_ERROR_COPY.WRONG_NETWORK });
      return;
    }
    setLocalError(null);
    try {
      const data = encodeFunctionData({ abi: b20AssetAbi, functionName: "transferWithMemo", args: [gift.recipient, BigInt(gift.rawAmount), gift.memo] });
      // Simulate first; policy blocks and pauses surface here as human-readable errors.
      await publicClient.call({ account: address, to: asset.address, data });
      setMachine("AWAITING_WALLET");
      const hash = await walletClient.sendTransaction({ account: address, chain: base, to: asset.address, data: withAttribution(data) });
      setTxHash(hash);
      setMachine("SUBMITTED");
      void patchWithRetry(`/api/gifts/${gift.id}`, { txHash: hash, status: "submitted" });
    } catch (err) {
      setLocalError(humanizeError(err));
      setMachine("FAILED");
    }
  };

  const busy = txState === "AWAITING_WALLET" || txState === "SUBMITTED" || txState === "PRECONFIRMED";

  const recipientName = resolved ? (resolved.basename ?? (resolved.profile?.handle ? `@${resolved.profile.handle}` : shortenAddress(resolved.address))) : gift ? (gift.recipientBasename ?? shortenAddress(gift.recipient)) : "";
  const shareText = `I just sent ${formatTokenAmount(gift ? (BigInt(gift.rawAmount) * multiplier) / wad : 0n, asset.decimals)} ${asset.underlying} (a tokenized stock on Base) to ${recipientName} with BStocks.`;

  const footer =
    step === "form" ? (
      <Button full size="lg" onClick={toReview} loading={busyPreview} disabled={!resolved || rawAmount === 0n || resolve.isFetching}>
        Review send
      </Button>
    ) : txState === "CONFIRMED" ? (
      <div className="flex gap-2">
        {gift && <ShareButton path={`/gifts/${gift.id}`} text={shareText} title="Share this gift" size="md" className="flex-1" label="Share" />}
        <Button full onClick={handleClose}>
          Done
        </Button>
      </div>
    ) : (
      <div className="flex gap-2">
        <Button variant="secondary" full disabled={busy} onClick={() => setStep("form")}>
          Back
        </Button>
        <Button full size="lg" loading={busy} onClick={send}>
          {txState === "FAILED" ? "Try again" : `Send ${asset.underlying}`}
        </Button>
      </div>
    );

  return (
    <Sheet open={open} onClose={handleClose} title={txState === "CONFIRMED" ? "Sent" : step === "form" ? (mode === "link" ? `Gift ${asset.underlying}` : `Send ${asset.underlying}`) : "Review send"} locked={busy} footer={mode === "link" ? undefined : footer}>
      {step === "form" && (
        <div className="mb-4">
          <Segmented<"direct" | "link">
            size="sm"
            ariaLabel="How to send"
            value={mode}
            onChange={setMode}
            options={[
              { value: "direct", label: "To an address" },
              { value: "link", label: "Claim link · no wallet needed" },
            ]}
          />
        </div>
      )}
      {mode === "link" && step === "form" ? (
        <ClaimLinkFlow asset={asset} raw={raw} scaled={scaled} priceUsd={priceUsd} onSent={onSent} />
      ) : step === "form" ? (
        <div className="flex flex-col gap-4">
          <Input
            label="Recipient"
            placeholder="alice.base.eth or 0x…"
            value={recipientInput}
            onChange={(e) => setRecipientInput(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            hint={
              recipientInput.trim().length >= 3 ? (
                resolve.isFetching ? (
                  "Resolving…"
                ) : resolved ? (
                  <RecipientCard r={resolved} compact />
                ) : (
                  "Not found. Check the Basename or paste a 0x address."
                )
              ) : (
                "Basenames resolve on Base. The exact address is shown before you confirm."
              )
            }
          />
          <AmountInput value={shares} onChange={setShares} unit={asset.underlying} ariaLabel={`Amount of ${asset.underlying} to send`} />
          <div className="flex gap-2 flex-wrap">
            {[25, 50, 75, 100].map((p) => (
              <Chip key={p} onClick={() => setPct(p)} disabled={raw === 0n}>
                {p === 100 ? "Max" : `${p}%`}
              </Chip>
            ))}
          </div>
          <div className="flex items-center justify-between text-[13px] text-ink-secondary">
            <span>Available</span>
            <span className="font-mono num">
              {formatTokenAmount(scaled, asset.decimals)} {asset.underlying} · {formatUsd(valueUsd)}
            </span>
          </div>
          <Input label="Message (optional, stored offchain)" placeholder="Happy birthday!" value={message} maxLength={280} onChange={(e) => setMessage(e.target.value)} />
          {error && <ErrorBanner message={error.message} detail={error.detail} />}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="module-grid grid-cols-2">
            <div className="p-3">
              <div className="text-[11px] font-mono uppercase text-ink-muted">Sending</div>
              <div className="display num text-[22px]">
                {formatTokenAmount(gift ? (BigInt(gift.rawAmount) * multiplier) / wad : 0n, asset.decimals)} {asset.underlying}
              </div>
              <div className="text-[12px] text-ink-secondary">{formatUsd(valueUsd)}</div>
            </div>
            <div className="p-3">
              <div className="text-[11px] font-mono uppercase text-ink-muted">To</div>
              {gift && (resolved && resolved.address.toLowerCase() === gift.recipient.toLowerCase() ? <RecipientCard r={resolved} compact /> : <AddressLabel address={gift.recipient} basename={gift.recipientBasename} explorer />)}
            </div>
          </div>
          <KeyValue k="Network" v="Base" />
          <KeyValue k="Reference id (onchain memo)" v={gift ? `${gift.memo.slice(0, 18)}…` : "—"} />
          {message.trim() && <KeyValue k="Message" v={message.trim()} mono={false} />}
          {warnings.map((w) => (
            <InfoBanner key={w} tone="warning">
              {w}
            </InfoBanner>
          ))}
          {(txState === "SUBMITTED" || txState === "PRECONFIRMED" || txState === "CONFIRMED") && <TxProgress state={txState} txHash={txHash} />}
          {txState === "AWAITING_WALLET" && <InfoBanner tone="info">Confirm the transfer in your wallet.</InfoBanner>}
          {error && <ErrorBanner message={error.message} detail={error.detail} />}
          <p className="text-[12px] text-ink-muted">Transfers are final. Double-check the recipient address above.</p>
        </div>
      )}
    </Sheet>
  );
}

export type { Address };
