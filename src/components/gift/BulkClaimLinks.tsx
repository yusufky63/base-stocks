"use client";

import { useMemo, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { encodeFunctionData, erc20Abi, formatUnits, type Hash } from "viem";
import { Check, Copy, TriangleAlert } from "lucide-react";
import type { B20AssetDTO } from "@/domain/asset";
import type { GiftRecord } from "@/domain/gift";
import { BASE_CHAIN_ID } from "@/config/chain";
import { apiPost, ApiError } from "@/lib/client-api";
import { claimPath, GIFT_ESCROW_ADDRESS, giftEscrowAbi, makeClaimSecret } from "@/lib/escrow";
import { formatShares } from "@/lib/gift/format";
import { patchWithRetry } from "@/lib/gift/record";
import { probeWalletCapabilities, sendCallsOrSequential } from "@/lib/gift/wallet";
import { humanizeError, TRADE_ERROR_COPY, type HumanError } from "@/lib/errors";
import { useAuth } from "@/hooks/useAuth";
import { parseAmountSafe, toRaw } from "@/lib/b20/math";
import { formatTokenAmount, formatUsd } from "@/lib/format";
import { AmountInput, Input } from "@/components/ui/Input";
import { Button, KeyValue } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/Segmented";
import { ErrorBanner, InfoBanner } from "@/components/common/display";
import { PrintCardsButton } from "@/components/common/PrintCardsButton";

const COUNTS = [2, 3, 5, 10];
const EXPIRY_DAYS: Array<[number, string]> = [
  [7, "7 days"],
  [30, "30 days"],
];

interface MadeLink {
  giftId: string;
  url: string;
}

type Phase = "form" | "working" | "recording" | "ready";

/**
 * Several claim links in one go — e.g. ten equal gifts for an event. One approval for the total
 * plus one escrow lock per link, batched atomically on Base Account (a plain wallet confirms
 * each transaction). Every link gets its own ephemeral key; none of them touches a server.
 */
export function BulkClaimLinks({ asset, raw, scaled, priceUsd, onSent }: { asset: B20AssetDTO; raw: bigint; scaled: bigint; priceUsd: number | null; onSent?: () => void }) {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });
  const { ensureSignedIn } = useAuth();

  const [count, setCount] = useState(3);
  const [sharesPer, setSharesPer] = useState("");
  const [days, setDays] = useState(7);
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<HumanError | null>(null);
  const [links, setLinks] = useState<MadeLink[]>([]);
  const [txHash, setTxHash] = useState<Hash | undefined>();
  const [copied, setCopied] = useState<string | null>(null);
  const [unrecorded, setUnrecorded] = useState(0);

  const multiplier = BigInt(asset.multiplier);
  const wad = BigInt(asset.wadPrecision);
  const rawPer = useMemo(() => {
    const s = parseAmountSafe(sharesPer, asset.decimals);
    return s === 0n ? 0n : toRaw(s, multiplier, wad);
  }, [sharesPer, asset.decimals, multiplier, wad]);
  const totalRaw = rawPer * BigInt(count);
  const insufficient = totalRaw > raw;
  const perLabel = `${formatShares(rawPer, asset)} ${asset.underlying}`;
  const totalUsd = priceUsd !== null ? Number(formatUnits(totalRaw, asset.decimals)) * priceUsd : null;

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1400);
    } catch {
      /* clipboard blocked; the links stay visible */
    }
  };

  const create = async () => {
    if (!address || !walletClient || !publicClient) return;
    if (chainId !== BASE_CHAIN_ID) {
      setError({ code: "WRONG_NETWORK", message: TRADE_ERROR_COPY.WRONG_NETWORK });
      return;
    }
    setError(null);
    setPhase("working");
    try {
      await ensureSignedIn();
      const expiresAt = Date.now() + days * 24 * 3600 * 1000;
      const expiry = BigInt(Math.floor(expiresAt / 1000));
      const made: Array<{ record: GiftRecord; createData: `0x${string}`; url: string }> = [];
      // Every record in this batch is stamped with the same escrow by the server; the approval
      // and the creates all go there. A record without one is brand new, so the current escrow
      // is the only answer.
      let escrow: typeof GIFT_ESCROW_ADDRESS = GIFT_ESCROW_ADDRESS;
      for (let i = 0; i < count; i++) {
        const secret = makeClaimSecret();
        const { gift: record } = await apiPost<{ gift: GiftRecord }>("/api/gifts", {
          kind: "claim-link",
          sender: address,
          assetAddress: asset.address,
          rawAmount: rawPer.toString(),
          message: message.trim() || undefined,
          escrowId: secret.escrowId,
          expiresAt,
        });
        escrow = record.escrowAddress ?? escrow;
        made.push({
          record,
          createData: encodeFunctionData({ abi: giftEscrowAbi, functionName: "create", args: [asset.address, rawPer, secret.claimKey, expiry, record.memo] }),
          url: `${window.location.origin}${claimPath(record.id, secret.privateKey)}`,
        });
      }
      const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [escrow, totalRaw] });

      /**
       * One prompt instead of one per link, wherever the wallet can manage it. A wallet that
       * speaks EIP-5792 without atomic guarantees still bundles the calls behind a single
       * confirmation and runs them in order; only the atomicity is lost, and the sequential
       * fallback never had it either. Each link remembers its own hash: an atomic batch is one
       * transaction shared by all, a non-atomic one lands a receipt per call.
       */
      const caps = await probeWalletCapabilities(walletClient, address);
      const { hashes } = await sendCallsOrSequential({
        walletClient,
        publicClient,
        address,
        caps,
        sponsor: true,
        batchWithoutAtomic: true,
        timeoutMs: 240_000,
        calls: [{ to: asset.address, data: approveData }, ...made.map((m) => ({ to: escrow, data: m.createData }))],
      });
      // The approval is call 0; link i is call i + 1.
      const perLink = made.map((_, i) => hashes[i + 1]);
      const hash = perLink[perLink.length - 1];
      setTxHash(hash);

      // Every link needs its hash on the record before it can be claimed; written and retried, not fired and forgotten.
      setPhase("recording");
      const written = await Promise.all(made.map((m, i) => (perLink[i] ? patchWithRetry(`/api/gifts/${m.record.id}`, { txHash: perLink[i], status: "submitted" }) : Promise.resolve(null))));
      setUnrecorded(written.filter((w) => w === null).length);
      setLinks(made.map((m) => ({ giftId: m.record.id, url: m.url })));
      setPhase("ready");
      onSent?.();
    } catch (err) {
      setError(err instanceof ApiError ? { code: (err.code in TRADE_ERROR_COPY ? err.code : "UNKNOWN") as HumanError["code"], message: err.message } : humanizeError(err));
      setPhase("form");
    }
  };

  if (phase === "ready" && links.length > 0) {
    return (
      <div className="flex flex-col gap-4">
        <div className="border border-line rounded-[8px] p-4 bg-surface">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Locked in escrow</div>
          <div className="display num text-[22px]">{`${links.length} links · ${perLabel} each`}</div>
        </div>
        {unrecorded > 0 && (
          <InfoBanner tone="warning">
            {`The stock is locked, but ${unrecorded === links.length ? "the links" : `${unrecorded} of the links`} could not be recorded just now. They start working once our next check finds them onchain (a few minutes); keep them.`}
          </InfoBanner>
        )}
        <InfoBanner tone="warning">
          <span className="inline-flex items-start gap-2">
            <TriangleAlert size={15} strokeWidth={1.75} className="shrink-0 mt-0.5 text-warning-fg" />
            <span>Each link IS its gift — whoever opens it first claims it. Shown once, stored nowhere; copy them now.</span>
          </span>
        </InfoBanner>
        <ul className="border border-line rounded-[8px] overflow-hidden">
          {links.map((l, i) => (
            <li key={l.giftId} className="flex items-center gap-3 px-3 py-2.5 border-b border-line last:border-b-0">
              <span className="font-mono text-[11px] text-ink-muted w-6 shrink-0">{`#${i + 1}`}</span>
              <span className="font-mono text-[12px] truncate flex-1">{l.url.replace(/^https?:\/\//, "")}</span>
              <Button size="sm" variant="secondary" onClick={() => void copy(l.giftId, l.url)}>
                {copied === l.giftId ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={2} />} {copied === l.giftId ? "Copied" : "Copy"}
              </Button>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Button full onClick={() => void copy("all", links.map((l, i) => `Gift ${i + 1}: ${l.url}`).join("\n"))}>
            {copied === "all" ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={2} />} {copied === "all" ? "All links copied" : "Copy all links"}
          </Button>
          <PrintCardsButton full count={links.length} cards={() => links.map((l, i) => ({ url: l.url, amount: perLabel, eyebrow: `Gift ${i + 1} of ${links.length}`, message: message.trim() || undefined, validDays: days }))} />
        </div>
        {txHash && <KeyValue k="Escrow tx" v={txHash} />}
        <p className="text-[12px] text-ink-muted">Unclaimed links can be cancelled one by one from Gift history; the stock comes straight back.</p>
      </div>
    );
  }

  const busy = phase === "working" || phase === "recording";
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-ink-secondary">Equal gifts for a group — every link claimable by whoever opens it, each with its own key.</p>
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">How many links</span>
        <Segmented<number> size="sm" ariaLabel="How many links" value={count} onChange={setCount} options={COUNTS.map((c) => ({ value: c, label: String(c) }))} />
      </div>
      <AmountInput value={sharesPer} onChange={setSharesPer} unit={`${asset.underlying} each`} ariaLabel={`Amount of ${asset.underlying} per link`} />
      <div className="flex items-center justify-between text-[13px] text-ink-secondary">
        <span>Total</span>
        <span className="font-mono num">
          {formatShares(totalRaw, asset)} {asset.underlying}
          {totalUsd !== null && totalRaw > 0n ? ` · ${formatUsd(totalUsd)}` : ""} · available {formatTokenAmount(scaled, asset.decimals)}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Claimable for</span>
        <Segmented<number> size="sm" ariaLabel="How long the links stay claimable" value={days} onChange={setDays} options={EXPIRY_DAYS.map(([d, label]) => ({ value: d, label }))} />
      </div>
      <Input label="Message on every link (optional)" placeholder="Thanks for coming!" value={message} maxLength={280} onChange={(e) => setMessage(e.target.value)} />
      {insufficient && <p className="text-[13px] text-danger-fg">{TRADE_ERROR_COPY.INSUFFICIENT_BALANCE}</p>}
      {error && <ErrorBanner message={error.message} detail={error.detail} />}
      <Button full size="lg" loading={busy} disabled={rawPer === 0n || insufficient} onClick={() => void create()}>
        {phase === "recording" ? "Recording the links…" : busy ? "Locking in escrow…" : `Create ${count} links${rawPer > 0n ? ` · ${perLabel} each` : ""}`}
      </Button>
      <p className="text-[12px] text-ink-muted">{`One confirmation on any wallet that can batch — the approval and all ${count} locks together, atomically on Base Account. A wallet that cannot batch falls back to the approval and then one confirmation per link.`}</p>
    </div>
  );
}
