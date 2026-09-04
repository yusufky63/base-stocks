"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { encodeFunctionData, erc20Abi, formatUnits, type Hash } from "viem";
import { base } from "viem/chains";
import { Link2, TriangleAlert } from "lucide-react";
import type { B20AssetDTO } from "@/domain/asset";
import type { GiftRecord } from "@/domain/gift";
import { BASE_CHAIN_ID } from "@/config/chain";
import { publicEnv } from "@/config/env";
import { apiPatch, apiPost, ApiError } from "@/lib/client-api";
import { attributionCapabilities, withAttribution } from "@/lib/attribution";
import { claimPath, GIFT_ESCROW_ADDRESS, giftEscrowAbi, makeClaimSecret, type ClaimSecret } from "@/lib/escrow";
import { humanizeError, TRADE_ERROR_COPY, type HumanError } from "@/lib/errors";
import { callAfterApproval } from "@/lib/trade/execute";
import { bpsOf, parseAmountSafe, toRaw } from "@/lib/b20/math";
import { formatTokenAmount, formatUsd } from "@/lib/format";
import { AmountInput, Input } from "@/components/ui/Input";
import { Button, KeyValue } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/Segmented";
import { ErrorBanner, InfoBanner } from "@/components/common/display";
import { ShareActions } from "@/components/common/ShareSheet";

const EXPIRY_DAYS: Array<[number, string]> = [
  [3, "3 days"],
  [7, "7 days"],
  [30, "30 days"],
];
const PCT_PRESETS = [25, 50, 75, 100];

type Phase = "form" | "signing" | "submitted" | "ready" | "failed";

/**
 * Claim-link gifts: lock the stock in the ownerless GiftEscrow against a fresh ephemeral key and
 * hand out a link whose fragment carries the key. The recipient needs no wallet up front — they
 * create a Base Account on the claim page and the claim is sponsored where the paymaster allows.
 * The secret is generated here in the browser and never sent to any server.
 */
export function ClaimLinkFlow({ asset, raw, scaled, priceUsd, onSent }: { asset: B20AssetDTO; raw: bigint; scaled: bigint; priceUsd: number | null; onSent?: () => void }) {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });

  const [shares, setShares] = useState("");
  const [pct, setPct] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [days, setDays] = useState(7);
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<HumanError | null>(null);
  const [gift, setGift] = useState<GiftRecord | null>(null);
  const [txHash, setTxHash] = useState<Hash | undefined>();
  const [secret, setSecret] = useState<ClaimSecret | null>(null);

  const multiplier = BigInt(asset.multiplier);
  const wad = BigInt(asset.wadPrecision);
  const rawAmount = useMemo(() => {
    const s = parseAmountSafe(shares, asset.decimals);
    if (s === 0n) return 0n;
    const r = toRaw(s, multiplier, wad);
    return r > raw ? raw : r;
  }, [shares, asset.decimals, multiplier, wad, raw]);
  const valueUsd = priceUsd !== null ? Number(formatUnits(rawAmount, asset.decimals)) * priceUsd : null;
  const applyPct = (p: number) => {
    setPct(p);
    setShares(formatUnits((bpsOf(raw, p * 100) * multiplier) / wad, asset.decimals));
  };
  const typeShares = (v: string) => {
    setPct(null); // a typed amount is no longer one of the presets
    setShares(v);
  };

  const link = gift && secret ? claimPath(gift.id, secret.privateKey) : null;
  const fullLink = link ? `${typeof window !== "undefined" ? window.location.origin : publicEnv.appUrl}${link}` : null;
  // QR of the full link for in-person gifting; rendered locally, the secret stays on this device.
  const qr = useQuery({
    queryKey: ["gift-qr", gift?.id ?? ""],
    queryFn: () => QRCode.toDataURL(fullLink!, { margin: 1, width: 320, color: { dark: "#0a0b0d", light: "#ffffff" } }),
    enabled: !!fullLink,
    staleTime: Infinity,
  });
  const amountLabel = `${formatTokenAmount((rawAmount * multiplier) / wad, asset.decimals)} ${asset.underlying}`;

  const create = async () => {
    if (!address || !walletClient || !publicClient) return;
    if (chainId !== BASE_CHAIN_ID) {
      setError({ code: "WRONG_NETWORK", message: TRADE_ERROR_COPY.WRONG_NETWORK });
      return;
    }
    setError(null);
    setPhase("signing");
    try {
      const secret = makeClaimSecret();
      setSecret(secret);
      const expiresAt = Date.now() + days * 24 * 3600 * 1000;
      const { gift: record } = await apiPost<{ gift: GiftRecord; warnings: string[] }>("/api/gifts", {
        kind: "claim-link",
        sender: address,
        assetAddress: asset.address,
        rawAmount: rawAmount.toString(),
        message: message.trim() || undefined,
        escrowId: secret.escrowId,
        expiresAt,
      });
      setGift(record);

      const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [GIFT_ESCROW_ADDRESS, rawAmount] });
      const createData = encodeFunctionData({ abi: giftEscrowAbi, functionName: "create", args: [asset.address, rawAmount, secret.claimKey, BigInt(Math.floor(expiresAt / 1000)), record.memo] });

      let atomic = false;
      let paymaster = false;
      try {
        const caps = (await walletClient.getCapabilities({ account: address, chainId: BASE_CHAIN_ID })) as { atomic?: { status?: string }; paymasterService?: { supported?: boolean } };
        atomic = caps.atomic?.status === "supported" || caps.atomic?.status === "ready";
        paymaster = !!publicEnv.paymasterUrl && !!caps.paymasterService?.supported;
      } catch {
        atomic = false;
      }

      let hash: Hash | undefined;
      if (atomic) {
        const { id } = await walletClient.sendCalls({
          account: address,
          chain: base,
          forceAtomic: true,
          calls: [
            { to: asset.address, data: withAttribution(approveData) },
            { to: GIFT_ESCROW_ADDRESS, data: withAttribution(createData) },
          ],
          capabilities: { ...attributionCapabilities(), ...(paymaster ? { paymasterService: { url: publicEnv.paymasterUrl } } : {}) },
        });
        setPhase("submitted");
        const result = await walletClient.waitForCallsStatus({ id, timeout: 180_000 });
        if (result.status === "failure") throw new Error("Batched transaction failed");
        hash = result.receipts?.[result.receipts.length - 1]?.transactionHash;
      } else {
        const ah = await walletClient.sendTransaction({ account: address, chain: base, to: asset.address, data: withAttribution(approveData) });
        await publicClient.waitForTransactionReceipt({ hash: ah });
        await callAfterApproval(publicClient, address, { to: GIFT_ESCROW_ADDRESS, data: createData });
        hash = await walletClient.sendTransaction({ account: address, chain: base, to: GIFT_ESCROW_ADDRESS, data: withAttribution(createData) });
        setPhase("submitted");
        await publicClient.waitForTransactionReceipt({ hash });
      }
      setTxHash(hash);
      void apiPatch(`/api/gifts/${record.id}`, { txHash: hash, status: "submitted" }).catch(() => undefined);
      setPhase("ready");
      onSent?.();
    } catch (err) {
      setError(err instanceof ApiError ? { code: (err.code in TRADE_ERROR_COPY ? err.code : "UNKNOWN") as HumanError["code"], message: err.message } : humanizeError(err));
      setPhase("failed");
    }
  };

  if (phase === "ready" && link && gift) {
    return (
      <div className="flex flex-col gap-4">
        <div className="border border-line rounded-[8px] p-4 bg-surface flex items-center gap-4">
          {qr.data && (
            <span className="shrink-0 rounded-[8px] bg-white p-1.5 border border-line">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr.data} alt="Claim link QR code" width={112} height={112} className="w-28 h-28" />
            </span>
          )}
          <div className="min-w-0 flex flex-col gap-1">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Locked in escrow</div>
            <div className="display num text-[24px]">{amountLabel}</div>
            <p className="text-[13px] text-ink-secondary">{`Valid for ${days} days. Let them scan the code in person, or share the link below. Unclaimed? Cancel any time and it comes straight back.`}</p>
          </div>
        </div>
        <InfoBanner tone="warning">
          <span className="inline-flex items-start gap-2">
            <TriangleAlert size={15} strokeWidth={1.75} className="shrink-0 mt-0.5 text-warning-fg" />
            <span>The link IS the gift: anyone who has it can claim. Share it only with the person it is for, over a private channel.</span>
          </span>
        </InfoBanner>
        <ShareActions path={link} text={`A gift for you: ${amountLabel}, a tokenized stock on Base. No wallet needed — open the link to claim it.`} />
        {txHash && <KeyValue k="Escrow tx" v={txHash} />}
        <p className="text-[12px] text-ink-muted">This link is shown once. It is not stored on any server; if you lose it, cancel the gift and create a new one.</p>
      </div>
    );
  }

  const busy = phase === "signing" || phase === "submitted";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-[13px] text-ink-secondary">
        <Link2 size={15} strokeWidth={1.75} className="text-primary shrink-0" />
        For someone without a wallet: they open your link, create a passkey wallet in seconds and the stock is theirs. Gas on the claim is covered where sponsorship allows.
      </div>
      <AmountInput value={shares} onChange={typeShares} unit={asset.underlying} ariaLabel={`Amount of ${asset.underlying} to gift`} />
      <Segmented<number>
        size="sm"
        ariaLabel="Share of your position"
        value={pct}
        onChange={applyPct}
        options={PCT_PRESETS.map((p) => ({ value: p, label: p === 100 ? "Max" : `${p}%`, disabled: raw === 0n }))}
      />
      <div className="flex items-center justify-between text-[13px] text-ink-secondary">
        <span>Available</span>
        <span className="font-mono num">
          {formatTokenAmount(scaled, asset.decimals)} {asset.underlying}
          {valueUsd !== null && rawAmount > 0n ? ` · sending ${formatUsd(valueUsd)}` : ""}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Claimable for</span>
        <Segmented<number> size="sm" ariaLabel="How long the link stays claimable" value={days} onChange={setDays} options={EXPIRY_DAYS.map(([d, label]) => ({ value: d, label }))} />
      </div>
      <Input label="Message (optional, stored offchain)" placeholder="Welcome to onchain stocks!" value={message} maxLength={280} onChange={(e) => setMessage(e.target.value)} />
      <p className="text-[12px] text-ink-muted">The stock moves into the BStocks gift escrow, an ownerless contract that can only pay whoever holds the claim link, or refund you. You can cancel any time before it is claimed.</p>
      {error && <ErrorBanner message={error.message} detail={error.detail} />}
      <Button full size="lg" loading={busy} disabled={rawAmount === 0n || raw === 0n} onClick={() => void create()}>
        {busy ? (phase === "submitted" ? "Locking in escrow…" : "Confirm in your wallet…") : `Create claim link${rawAmount > 0n ? ` · ${amountLabel}` : ""}`}
      </Button>
    </div>
  );
}
