"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import type { B20AssetDTO } from "@/domain/asset";
import type { TradeProviderId, TradeSide } from "@/domain/trade";
import type { ResolvedRecipient } from "@/domain/gift";
import type { GiftRecord, TradeQuoteSummary } from "@/lib/client-api";
import { useTrade } from "@/hooks/useTrade";
import { useAuth } from "@/hooks/useAuth";
import { apiPost } from "@/lib/client-api";
import { ShareButton } from "@/components/common/ShareSheet";
import { USDC_DECIMALS } from "@/config/chain";
import { formatTokenAmount, formatUsd, formatPct, shortenAddress } from "@/lib/format";
import { Sheet } from "@/components/ui/Sheet";
import { Button, KeyValue } from "@/components/ui/primitives";
import { Collapsible } from "@/components/ui/Collapsible";
import { ErrorBanner, InfoBanner } from "@/components/common/display";
import { RecipientCard } from "@/components/common/RecipientCard";
import { PROVIDER_LABEL } from "./RouteCompare";
import { TxProgress } from "./TxProgress";

interface Props {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
  side: TradeSide;
  asset: B20AssetDTO;
  summary: TradeQuoteSummary;
  sellAmount: bigint;
  recipient?: ResolvedRecipient;
  slippageBps: number;
  /** Buys only: what the sellAmount is denominated in, and its USD value when paying with ETH. */
  payWith?: "USDC" | "ETH";
  payUsd?: number;
  /** Provider for the firm quote; `strictProvider` means the user picked it (no fallback). */
  provider?: TradeProviderId;
  strictProvider?: boolean;
}

/**
 * Review → Confirm wallet action → Submitted / Preconfirmed / Confirmed.
 * Shows: stock, amount spent, estimated received, executable price, price impact, network = Base,
 * estimated network fee, clear CTA. Advanced data collapsed under "Execution details".
 */
export function TradeReviewSheet({ open, onClose, onDone, side, asset, summary, sellAmount, recipient, slippageBps, payWith = "USDC", payUsd, provider, strictProvider = false }: Props) {
  const trade = useTrade();
  const { address: buyer } = useAccount();
  const auth = useAuth();
  const buy = side === "buy";
  const payEth = buy && payWith === "ETH";
  const usdcOut = buy ? (payEth ? (payUsd ?? 0) : Number(formatUnits(sellAmount, USDC_DECIMALS))) : Number(formatUnits(BigInt(summary.buyAmount), USDC_DECIMALS));
  const tokenAmount = buy ? summary.buyAmount : summary.sellAmount;
  const locked = trade.isBusy;
  const doneReported = useRef(false);

  const handleClose = () => {
    trade.reset();
    doneReported.current = false;
    onClose();
  };

  useEffect(() => {
    if (trade.state === "CONFIRMED" && !doneReported.current) {
      doneReported.current = true;
      onDone?.();
    }
  }, [trade.state, onDone]);

  // Buy-for-recipient: record the gift once the purchase is submitted (side effect only).
  const giftReported = useRef<string | null>(null);
  const [giftId, setGiftId] = useState<string | null>(null);
  useEffect(() => {
    if (!recipient || !buyer || !trade.txHash || giftReported.current === trade.txHash || !trade.quote) return;
    giftReported.current = trade.txHash;
    void apiPost<{ gift: GiftRecord }>("/api/gifts", {
      kind: "buy-for-recipient",
      sender: buyer,
      recipient: recipient.address,
      assetAddress: asset.address,
      rawAmount: trade.quote.buyAmount,
      txHash: trade.txHash,
    })
      .then((r) => setGiftId(r.gift.id))
      .catch(() => undefined);
  }, [recipient, buyer, trade.txHash, trade.quote, asset.address]);

  const title = trade.state === "CONFIRMED" ? (recipient ? "Gift sent" : buy ? "Purchase complete" : "Sale complete") : trade.state === "FAILED" ? "Not completed" : buy ? `Review buy` : `Review sell`;

  // Referral attribution: the signed-in wallet's first confirmed trade (side effect only).
  const referralReported = useRef<string | null>(null);
  useEffect(() => {
    if (trade.state !== "CONFIRMED" || !trade.txHash || !auth.isSignedIn || referralReported.current === trade.txHash) return;
    referralReported.current = trade.txHash;
    void apiPost("/api/referrals", { txHash: trade.txHash }).catch(() => undefined);
  }, [trade.state, trade.txHash, auth.isSignedIn]);

  const recipientName = recipient ? (recipient.basename ?? (recipient.profile?.handle ? `@${recipient.profile.handle}` : shortenAddress(recipient.address))) : null;
  const shareText = recipient
    ? `I just gifted ${formatTokenAmount(tokenAmount, asset.decimals)} ${asset.underlying} (a tokenized stock on Base) to ${recipientName} with BStocks.`
    : buy
      ? `I just bought ${asset.underlying} as a tokenized stock on Base with BStocks.`
      : `I just sold ${asset.underlying} as a tokenized stock on Base with BStocks.`;
  const sharePath = recipient && giftId ? `/gifts/${giftId}` : `/stocks/${asset.address}`;

  const cta = () => {
    if (trade.state === "CONFIRMED")
      return (
        <div className="flex gap-2">
          <ShareButton path={sharePath} text={shareText} title={recipient ? "Share this gift" : "Share your trade"} size="md" className="flex-1" label="Share" />
          <Button full onClick={handleClose}>
            Done
          </Button>
        </div>
      );
    if (trade.state === "FAILED")
      return (
        <div className="flex gap-2">
          <Button variant="secondary" full onClick={handleClose}>
            Close
          </Button>
          <Button full onClick={() => trade.execute({ side, assetAddress: asset.address, sellAmount, payWith: buy ? payWith : undefined, provider: provider ?? summary.provider, strictProvider, recipient: recipient?.address, slippageBps, usdValue: usdcOut })}>
            Try again
          </Button>
        </div>
      );
    if (trade.state === "IDLE")
      return (
        <Button full size="lg" onClick={() => trade.execute({ side, assetAddress: asset.address, sellAmount, payWith: buy ? payWith : undefined, provider: provider ?? summary.provider, strictProvider, recipient: recipient?.address, slippageBps, usdValue: usdcOut })}>
          {buy ? `Buy ${asset.underlying} for ${formatUsd(usdcOut)}` : `Sell ${asset.underlying} for ≈ ${formatUsd(usdcOut)}`}
        </Button>
      );
    return (
      <Button full size="lg" loading disabled>
        {STATE_COPY[trade.state]}
      </Button>
    );
  };

  return (
    <Sheet open={open} onClose={handleClose} title={title} locked={locked} footer={cta()}>
      <div className="flex flex-col gap-4">
        <div className="module-grid grid-cols-2">
          <div className="p-3">
            <div className="text-[11px] font-mono uppercase tracking-[0.08em] text-ink-muted">{buy ? "You pay" : "You sell"}</div>
            <div className="display num text-[22px]">{buy ? (payEth ? `${formatTokenAmount(sellAmount, 18, 6)} ETH` : formatUsd(usdcOut)) : `${formatTokenAmount(tokenAmount, asset.decimals)} ${asset.underlying}`}</div>
            {payEth && <div className="text-[12px] text-ink-muted">≈ {formatUsd(usdcOut)} at the current ETH price</div>}
          </div>
          <div className="p-3">
            <div className="text-[11px] font-mono uppercase tracking-[0.08em] text-ink-muted">{buy ? "You receive (est.)" : "You receive (est.)"}</div>
            <div className="display num text-[22px]">{buy ? `${formatTokenAmount(tokenAmount, asset.decimals)} ${asset.underlying}` : formatUsd(usdcOut)}</div>
          </div>
        </div>

        {recipient && (
          <div className="border border-line rounded-[8px] px-3 py-2">
            <div className="text-[11px] font-mono uppercase tracking-[0.08em] text-ink-muted mb-1">Recipient</div>
            <RecipientCard r={recipient} compact />
          </div>
        )}

        <div>
          <KeyValue k="Stock" v={`${asset.name} (${asset.symbol})`} mono={false} />
          <KeyValue k="Executable price" v={summary.executablePriceUsd !== null ? `${formatUsd(summary.executablePriceUsd, { precise: true })} / token` : "—"} />
          <KeyValue k={`Price impact${summary.priceImpactBasis ? ` vs ${summary.priceImpactBasis}` : ""}`} v={summary.priceImpactPct !== null ? formatPct(summary.priceImpactPct, { sign: true }) : "—"} />
          <KeyValue k="Network" v="Base" />
          <KeyValue k="Provider" v={`${PROVIDER_LABEL[summary.provider] ?? summary.provider}${strictProvider ? " · your choice" : " · best net"}`} />
          <KeyValue k="Est. network fee" v={summary.estimatedNetworkFeeUsd !== null ? formatUsd(summary.estimatedNetworkFeeUsd, { precise: true }) : "—"} />
        </div>

        {summary.warnings.length > 0 && (
          <InfoBanner tone="warning">
            <ul className="list-disc pl-4 flex flex-col gap-1">
              {summary.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </InfoBanner>
        )}

        {(trade.state !== "IDLE" && trade.state !== "FAILED") && (
          <div className="border border-line rounded-[8px] p-3 flex flex-col gap-2">
            <div className="text-[13px] text-ink-secondary">{STATE_COPY[trade.state]}</div>
            {(trade.state === "SUBMITTED" || trade.state === "PRECONFIRMED" || trade.state === "CONFIRMED") && <TxProgress state={trade.state} txHash={trade.txHash} />}
          </div>
        )}

        {trade.error && <ErrorBanner message={trade.error.message} detail={trade.error.detail} />}

        <Collapsible title="Execution details">
          <KeyValue k="Route" v={summary.route.length ? summary.route.map((r) => `${r.source}${r.proportionBps ? ` ${(r.proportionBps / 100).toFixed(0)}%` : ""}`).join(", ") : "Best available"} />
          <KeyValue k="Min. received" v={summary.minBuyAmount ? (buy ? `${formatTokenAmount(summary.minBuyAmount, asset.decimals)} ${asset.underlying}` : formatUsd(Number(formatUnits(BigInt(summary.minBuyAmount), USDC_DECIMALS)))) : "—"} />
          <KeyValue k="Slippage tolerance" v={`${(slippageBps / 100).toFixed(2)}%`} />
          <KeyValue k="Approval" v={summary.allowanceRequired ? "Required (scoped to this amount)" : "Not required"} />
          <KeyValue k="Spender" v={summary.allowanceSpender ?? "—"} />
          <KeyValue k="Execution mode" v={trade.mode === "batched" ? `Atomic batch${trade.sponsored ? " · sponsored gas" : ""}` : trade.mode === "sequential" ? "Sequential" : "—"} />
          <KeyValue k="Quote fetched" v={new Date(summary.fetchedAt).toLocaleTimeString()} />
          {trade.approvalHash && <KeyValue k="Approval tx" v={trade.approvalHash} />}
          {trade.quote?.quoteId && <KeyValue k="Quote id" v={trade.quote.quoteId} />}
        </Collapsible>
      </div>
    </Sheet>
  );
}

const STATE_COPY: Record<string, string> = {
  IDLE: "",
  LOADING_PRICE: "Fetching price…",
  READY: "Ready",
  GETTING_FIRM_QUOTE: "Getting a firm quote…",
  APPROVAL_REQUIRED: "Approval needed",
  AWAITING_WALLET: "Confirm in your wallet…",
  SUBMITTED: "Submitted to Base",
  PRECONFIRMED: "Preconfirmed",
  CONFIRMED: "Confirmed",
  FAILED: "Not completed",
};
