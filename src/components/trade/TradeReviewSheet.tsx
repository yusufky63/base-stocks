"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import type { B20AssetDTO } from "@/domain/asset";
import type { TradeProviderId, TradeSide } from "@/domain/trade";
import type { ResolvedRecipient } from "@/domain/gift";
import type { GiftRecord, TradeQuoteSummary } from "@/lib/client-api";
import { useTrade } from "@/hooks/useTrade";
import { apiPost } from "@/lib/client-api";
import { ShareActions } from "@/components/common/ShareSheet";
import { USDC_DECIMALS } from "@/config/chain";
import { toScaled } from "@/lib/b20/math";
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
  /** Best execution is on: CoW is asked first for the firm quote and the sheet says which route took it. */
  bestExecution?: boolean;
}

/**
 * Review → Confirm wallet action → Submitted / Preconfirmed / Confirmed.
 * Shows: stock, amount spent, estimated received, executable price, price impact, network = Base,
 * estimated network fee, clear CTA. Advanced data collapsed under "Execution details".
 */
export function TradeReviewSheet({ open, onClose, onDone, side, asset, summary, sellAmount, recipient, slippageBps, payWith = "USDC", payUsd, provider, strictProvider = false, bestExecution = false }: Props) {
  const trade = useTrade();
  const { address: buyer } = useAccount();
  const preparedFor = useRef<string | null>(null);
  const buy = side === "buy";
  const payEth = buy && payWith === "ETH";
  /** Firm quote once fetched; the indicative summary only bridges the first paint (spec: review shows the firm quote). */
  const live = trade.quote ?? summary;
  const firm = trade.quote !== null;
  const usdcOut = buy ? (payEth ? (payUsd ?? 0) : Number(formatUnits(sellAmount, USDC_DECIMALS))) : Number(formatUnits(BigInt(live.buyAmount), USDC_DECIMALS));
  const tokenAmount = buy ? live.buyAmount : live.sellAmount;
  // Quotes are in raw token units; the user holds share-equivalents (raw × multiplier), which is what every balance on the page shows.
  const shares = (raw: string | bigint) => formatTokenAmount(toScaled(typeof raw === "string" ? BigInt(raw) : raw, BigInt(asset.multiplier), BigInt(asset.wadPrecision)), asset.decimals);
  const partialReceived = trade.partialFill && trade.order ? (buy ? `${shares(trade.order.executedBuyAmount)} ${asset.underlying}` : formatUsd(Number(formatUnits(BigInt(trade.order.executedBuyAmount), USDC_DECIMALS)))) : null;

  const execParams = { side, assetAddress: asset.address, sellAmount, payWith: buy ? payWith : undefined, provider: provider ?? summary.provider, strictProvider, bestExecution, recipient: recipient?.address, slippageBps, usdValue: usdcOut };
  // Fetch the firm quote as soon as the review opens; the CTA signs exactly what is on screen.
  useEffect(() => {
    if (!open) {
      preparedFor.current = null;
      return;
    }
    const key = `${side}:${sellAmount}:${provider ?? ""}:${strictProvider}:${bestExecution}:${payWith}:${slippageBps}:${recipient?.address ?? ""}`;
    if (preparedFor.current === key || trade.state !== "IDLE") return;
    preparedFor.current = key;
    void trade.prepare(execParams);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, side, sellAmount, provider, strictProvider, bestExecution, payWith, slippageBps, recipient?.address, trade.state]);
  const locked = trade.isBusy;
  const doneReported = useRef(false);
  const signed = trade.mode === "order" || (trade.mode === null && live.provider === "cow");

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

  const title = trade.state === "CONFIRMED" ? (trade.partialFill ? "Partially filled" : recipient ? "Gift sent" : buy ? "Purchase complete" : "Sale complete") : trade.state === "FAILED" ? "Not completed" : buy ? `Review buy` : `Review sell`;

  const recipientName = recipient ? (recipient.basename ?? (recipient.profile?.handle ? `@${recipient.profile.handle}` : shortenAddress(recipient.address))) : null;
  const shareText = recipient
    ? `I just gifted ${shares(tokenAmount)} ${asset.underlying} (a tokenized stock on Base) to ${recipientName} with BaseStocks.`
    : buy
      ? `I just bought ${asset.underlying} as a tokenized stock on Base with BaseStocks.`
      : `I just sold ${asset.underlying} as a tokenized stock on Base with BaseStocks.`;
  const sharePath = recipient && giftId ? `/gifts/${giftId}` : `/stocks/${asset.address}`;

  const cta = () => {
    if (trade.state === "CONFIRMED")
      return (
        <Button full onClick={handleClose}>
          Done
        </Button>
      );
    if (trade.state === "FAILED")
      return (
        <div className="flex gap-2">
          <Button variant="secondary" full onClick={handleClose}>
            Close
          </Button>
          <Button full onClick={() => trade.execute(execParams)}>
            Try again
          </Button>
        </div>
      );
    if (trade.state === "IDLE" || trade.state === "READY")
      return (
        <Button full size="lg" onClick={() => trade.execute(execParams)}>
          {buy ? `Buy ${asset.underlying} for ${formatUsd(usdcOut)}` : `Sell ${asset.underlying} for ${firm ? "" : "≈ "}${formatUsd(usdcOut)}`}
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
            <div className="display num text-[22px]">{buy ? (payEth ? `${formatTokenAmount(sellAmount, 18, 6)} ETH` : formatUsd(usdcOut)) : `${shares(tokenAmount)} ${asset.underlying}`}</div>
            {payEth && <div className="text-[12px] text-ink-muted">≈ {formatUsd(usdcOut)} at the current ETH price</div>}
          </div>
          <div className="p-3">
            <div className="text-[11px] font-mono uppercase tracking-[0.08em] text-ink-muted">{buy ? "You receive (est.)" : "You receive (est.)"}</div>
            <div className="display num text-[22px]">{buy ? `${shares(tokenAmount)} ${asset.underlying}` : formatUsd(usdcOut)}</div>
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
          <KeyValue k="Executable price" v={live.executablePricePerShareUsd !== null ? `${formatUsd(live.executablePricePerShareUsd, { precise: true })} / share` : "—"} />
          {/* Impact is what this trade does to the pool; the gap to the Chainlink reference is the pool's premium or discount. Without a trusted pool price the impact figure is itself the gap. */}
          <KeyValue k={live.priceImpactBasis === "market" ? "Price impact" : "vs reference"} v={live.priceImpactPct !== null ? formatPct(live.priceImpactPct, { sign: true }) : "—"} />
          {live.priceImpactBasis === "market" && live.referenceGapPct !== null && live.referenceGapPct !== undefined && <KeyValue k="vs reference" v={formatPct(live.referenceGapPct, { sign: true })} />}
          <KeyValue k="Network" v="Base" />
          <KeyValue k="Provider" v={`${PROVIDER_LABEL[live.provider] ?? live.provider}${strictProvider ? " · your choice" : live.execution?.applied ? " · best execution" : bestExecution ? " · best execution missed, best net" : " · best net"}${firm ? " · firm quote" : trade.state === "GETTING_FIRM_QUOTE" ? " · fetching firm quote…" : ""}`} />
          <KeyValue k="Est. network fee" v={live.provider === "cow" ? "Paid by the solver · included in the price" : live.estimatedNetworkFeeUsd !== null ? `${live.networkFeeEstimated ? "≈ " : ""}${formatUsd(live.estimatedNetworkFeeUsd, { precise: true })}` : "—"} />
        </div>

        {live.provider === "cow" && (trade.state === "IDLE" || trade.state === "READY") && (
          <InfoBanner tone="info">
            You sign an order instead of sending a transaction. CoW Protocol solvers compete to fill it within about 30 minutes and pay the gas; if nobody can, it expires and nothing moves. A one-time approval for this amount is still a transaction{trade.sponsored ? " (sponsored)" : ""}.
          </InfoBanner>
        )}

        {trade.partialFill && partialReceived && (
          <InfoBanner tone="warning">
            The order {trade.order?.status === "cancelled" ? "was cancelled" : "expired"} after a partial fill: {partialReceived} {buy ? "arrived" : "was received"} for the part that filled, and the rest of the order did not execute. Nothing else moved.
          </InfoBanner>
        )}

        {live.warnings.length > 0 && (
          <InfoBanner tone="warning">
            <ul className="list-disc pl-4 flex flex-col gap-1">
              {live.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </InfoBanner>
        )}

        {trade.state === "CONFIRMED" && (
          <div className="flex flex-col gap-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{recipient ? "Share this gift" : "Share your trade"}</div>
            <ShareActions path={sharePath} text={shareText} />
          </div>
        )}
        {(trade.state !== "IDLE" && trade.state !== "FAILED") && (
          <div className="border border-line rounded-[8px] p-3 flex flex-col gap-2">
            <div className="text-[13px] text-ink-secondary">{signed ? (ORDER_STATE_COPY[trade.state] ?? STATE_COPY[trade.state]) : STATE_COPY[trade.state]}</div>
            {(trade.state === "SUBMITTED" || trade.state === "PRECONFIRMED" || trade.state === "CONFIRMED") && <TxProgress state={trade.state} txHash={trade.txHash} order={signed} />}
            {trade.order && (
              <a href={trade.order.explorerUrl} target="_blank" rel="noreferrer" className="text-[12px] text-primary font-medium">
                View order on CoW Explorer ↗
              </a>
            )}
          </div>
        )}

        {trade.error && <ErrorBanner message={trade.error.message} detail={trade.error.detail} />}

        <Collapsible title="Execution details">
          <KeyValue k="Route" v={live.route.length ? live.route.map((r) => `${r.source}${r.proportionBps ? ` ${(r.proportionBps / 100).toFixed(0)}%` : ""}`).join(", ") : "Best available"} />
          <KeyValue k="Executable price · per token" v={live.executablePriceUsd !== null ? formatUsd(live.executablePriceUsd, { precise: true }) : "—"} />
          <KeyValue k="Min. received" v={live.minBuyAmount ? (buy ? `${shares(live.minBuyAmount)} ${asset.underlying}` : formatUsd(Number(formatUnits(BigInt(live.minBuyAmount), USDC_DECIMALS)))) : "—"} />
          <KeyValue k="Slippage tolerance" v={`${(slippageBps / 100).toFixed(2)}%`} />
          <KeyValue k="Approval" v={live.allowanceRequired ? "Required (scoped to this amount)" : "Not required"} />
          <KeyValue k="Spender" v={live.allowanceSpender ?? "—"} />
          <KeyValue k="Execution mode" v={trade.mode === "order" ? `Signed order · gasless${trade.sponsored ? " · approval sponsored" : ""}` : trade.mode === "batched" ? `Atomic batch${trade.sponsored ? " · sponsored gas" : ""}` : trade.mode === "sequential" ? "Sequential" : "—"} />
          {trade.orderUid && <KeyValue k="Order uid" v={`${trade.orderUid.slice(0, 10)}…${trade.orderUid.slice(-6)}`} />}
          <KeyValue k="Quote fetched" v={`${new Date(live.fetchedAt).toLocaleTimeString()}${firm ? " · firm" : " · indicative"}`} />
          {trade.approvalHash && <KeyValue k="Approval tx" v={trade.approvalHash} />}
          {trade.quote?.quoteId && <KeyValue k="Quote id" v={trade.quote.quoteId} />}
        </Collapsible>
      </div>
    </Sheet>
  );
}

const ORDER_STATE_COPY: Record<string, string> = {
  APPROVAL_REQUIRED: "Approval needed for this amount",
  AWAITING_WALLET: "Sign in your wallet…",
  SUBMITTED: "Order placed. Solvers are filling it, usually within a minute…",
  PRECONFIRMED: "Partially filled, waiting for the rest…",
  CONFIRMED: "Filled",
};

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
