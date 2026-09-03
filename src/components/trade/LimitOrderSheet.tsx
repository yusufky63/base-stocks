"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { formatUnits, parseUnits, type Address, type Hash } from "viem";
import type { B20AssetDTO } from "@/domain/asset";
import type { TradeSide, TradeState } from "@/domain/trade";
import { apiPost, ApiError, type SignedOrderRequest } from "@/lib/client-api";
import { BASE_CHAIN_ID, USDC_DECIMALS } from "@/config/chain";
import { equityPricePerShare, parseAmountSafe, toRaw } from "@/lib/b20/math";
import { formatTokenAmount, formatUsd } from "@/lib/format";
import { humanizeError, TRADE_ERROR_COPY, type HumanError } from "@/lib/errors";
import { executeSignedOrder } from "@/lib/trade/execute";
import { useOrderStatus } from "@/hooks/queries";
import { useQueryClient } from "@tanstack/react-query";
import { Sheet } from "@/components/ui/Sheet";
import { AmountInput } from "@/components/ui/Input";
import { Button, Chip, KeyValue } from "@/components/ui/primitives";
import { ErrorBanner, InfoBanner } from "@/components/common/display";
import { TxProgress } from "./TxProgress";

interface Props {
  open: boolean;
  onClose: () => void;
  side: TradeSide;
  asset: B20AssetDTO;
  /** Current market price per raw token (USD), used only as the default limit. */
  priceUsd: number | null;
  /** Raw stock balance (for sells) and USDC balance (for buys), base units. */
  rawStockBalance: bigint;
  usdcBalance: bigint;
  onPlaced?: () => void;
}

const EXPIRIES: Array<[number, string]> = [
  [60 * 60, "1 hour"],
  [3 * 60 * 60, "3 hours"],
];

/**
 * A CoW limit order: the user names shares and a price per share; the order sits in the order
 * book (partially fillable) until a solver can execute at that price or better, or it expires.
 * Amounts are share-equivalents (multiplier-aware); the signed order carries raw token units.
 */
export function LimitOrderSheet({ open, onClose, side, asset, priceUsd, rawStockBalance, usdcBalance, onPlaced }: Props) {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });
  const qc = useQueryClient();
  const buy = side === "buy";
  const multiplier = BigInt(asset.multiplier);
  const wad = BigInt(asset.wadPrecision);
  const marketPerShare = priceUsd !== null ? equityPricePerShare(priceUsd, multiplier, wad) : null;

  const [shares, setShares] = useState("");
  const [limit, setLimit] = useState("");
  const [validFor, setValidFor] = useState(EXPIRIES[1]![0]);
  const [state, setState] = useState<TradeState>("IDLE");
  const [error, setError] = useState<HumanError | null>(null);
  const [orderUid, setOrderUid] = useState<string | undefined>();
  const [approvalHash, setApprovalHash] = useState<Hash | undefined>();
  const order = useOrderStatus(orderUid).data ?? null;

  // The market price is the default limit until the user types one (no effect needed).
  const limitText = limit !== "" ? limit : marketPerShare !== null ? marketPerShare.toFixed(2) : "";
  const sharesNum = Number(shares) || 0;
  const limitNum = Number(limitText) || 0;
  const usdTotal = sharesNum * limitNum;
  // Raw token units for the requested share-equivalents (scaled = raw × multiplier / WAD).
  const rawTokens = sharesNum > 0 ? toRaw(parseAmountSafe(shares, asset.decimals), multiplier, wad) : 0n;
  const usdcUnits = usdTotal > 0 ? parseUnits(usdTotal.toFixed(USDC_DECIMALS), USDC_DECIMALS) : 0n;
  const sellAmount = buy ? usdcUnits : rawTokens;
  const minBuyAmount = buy ? rawTokens : usdcUnits;
  const balance = buy ? usdcBalance : rawStockBalance;
  const insufficient = sellAmount > balance;
  const vsMarket = marketPerShare !== null && limitNum > 0 ? ((limitNum - marketPerShare) / marketPerShare) * 100 : null;
  const canPlace = sellAmount > 0n && minBuyAmount > 0n && !insufficient && state === "IDLE";

  let liveState: TradeState = state;
  if ((state === "SUBMITTED" || state === "PRECONFIRMED") && order) {
    if (order.status === "fulfilled") liveState = "CONFIRMED";
    else if (BigInt(order.executedBuyAmount) > 0n) liveState = "PRECONFIRMED";
  }

  const reset = () => {
    setState("IDLE");
    setError(null);
    setOrderUid(undefined);
    setApprovalHash(undefined);
  };
  const close = () => {
    reset();
    onClose();
  };

  const place = async () => {
    setError(null);
    if (!address || !walletClient || !publicClient) {
      setError({ code: "WALLET_NOT_CONNECTED", message: TRADE_ERROR_COPY.WALLET_NOT_CONNECTED });
      setState("FAILED");
      return;
    }
    try {
      setState("GETTING_FIRM_QUOTE");
      const { order: prepared } = await apiPost<{ order: SignedOrderRequest; warnings: string[] }>("/api/trade/orders/prepare", {
        side,
        assetAddress: asset.address,
        sellAmount: sellAmount.toString(),
        minBuyAmount: minBuyAmount.toString(),
        owner: address,
        validForSeconds: validFor,
      });
      const result = await executeSignedOrder({ address, chainId, walletClient, publicClient }, prepared, { onState: setState, onApproval: setApprovalHash });
      setOrderUid(result.orderUid);
      setState("SUBMITTED");
      void qc.invalidateQueries({ queryKey: ["orders", address.toLowerCase()] });
      onPlaced?.();
    } catch (err) {
      setError(err instanceof ApiError ? { code: (err.code in TRADE_ERROR_COPY ? err.code : "UNKNOWN") as HumanError["code"], message: err.message, detail: err.code } : humanizeError(err));
      setState("FAILED");
    }
  };

  const busy = liveState === "GETTING_FIRM_QUOTE" || liveState === "APPROVAL_REQUIRED" || liveState === "AWAITING_WALLET";
  const title = liveState === "CONFIRMED" ? "Order filled" : liveState === "SUBMITTED" || liveState === "PRECONFIRMED" ? "Order open" : `Limit ${buy ? "buy" : "sell"} · ${asset.underlying}`;

  const footer =
    liveState === "SUBMITTED" || liveState === "PRECONFIRMED" || liveState === "CONFIRMED" ? (
      <Button full onClick={close}>
        Done
      </Button>
    ) : liveState === "FAILED" ? (
      <div className="flex gap-2">
        <Button variant="secondary" full onClick={close}>
          Close
        </Button>
        <Button full onClick={reset}>
          Edit order
        </Button>
      </div>
    ) : (
      <Button full size="lg" variant={buy ? "primary" : "ink"} disabled={!canPlace} loading={busy} onClick={() => void place()}>
        {busy ? STATE_COPY[liveState] : `Place limit ${buy ? "buy" : "sell"}${usdTotal > 0 ? ` · ${formatUsd(usdTotal)}` : ""}`}
      </Button>
    );

  return (
    <Sheet open={open} onClose={close} title={title} locked={busy} footer={footer}>
      <div className="flex flex-col gap-4">
        {liveState === "IDLE" || liveState === "FAILED" || busy ? (
          <>
            <AmountInput value={shares} onChange={setShares} unit={`${asset.underlying} shares`} ariaLabel="Shares" autoFocus />
            <AmountInput value={limitText} onChange={setLimit} unit="USD / share" ariaLabel="Limit price per share" />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] text-ink-secondary">Expires in</span>
              {EXPIRIES.map(([s, label]) => (
                <Chip key={s} active={validFor === s} onClick={() => setValidFor(s)} className="h-8 min-h-[32px] px-3 text-[12px]">
                  {label}
                </Chip>
              ))}
            </div>
            <div>
              <KeyValue k={buy ? "You pay at most" : "You receive at least"} v={usdTotal > 0 ? formatUsd(usdTotal) : "—"} />
              <KeyValue k="Market price / share" v={marketPerShare !== null ? formatUsd(marketPerShare, { precise: true }) : "—"} />
              <KeyValue k="Your limit vs market" v={vsMarket !== null ? `${vsMarket >= 0 ? "+" : ""}${vsMarket.toFixed(2)}%` : "—"} />
              <KeyValue k={buy ? "Balance (USDC)" : `Balance (${asset.underlying})`} v={buy ? formatUsd(Number(formatUnits(usdcBalance, USDC_DECIMALS))) : `${formatTokenAmount((rawStockBalance * multiplier) / wad, asset.decimals)} shares`} />
            </div>
            {insufficient && <p className="text-[13px] text-danger-fg">{TRADE_ERROR_COPY.INSUFFICIENT_BALANCE}</p>}
            {buy && vsMarket !== null && vsMarket > 0.5 && <InfoBanner tone="warning">Your limit is above the market price; the order will likely fill right away at the market price, not at your limit.</InfoBanner>}
            {!buy && vsMarket !== null && vsMarket < -0.5 && <InfoBanner tone="warning">Your limit is below the market price; the order will likely fill right away at the market price, not at your limit.</InfoBanner>}
            <InfoBanner>
              Filled by CoW Protocol solvers at your price or better, in parts if needed, with gas paid by the solver. Fees are taken from the difference to the market price, so an order exactly at market may not fill until the price moves a little. Expires after {EXPIRIES.find(([s]) => s === validFor)?.[1]} if unfilled; cancel any time from Your orders.
            </InfoBanner>
            {approvalHash && <KeyValue k="Approval tx" v={approvalHash} />}
            {error && <ErrorBanner message={error.message} detail={error.detail} />}
          </>
        ) : (
          <>
            <div className="border border-line rounded-[8px] p-3 flex flex-col gap-2">
              <div className="text-[13px] text-ink-secondary">{STATE_COPY[liveState]}</div>
              <TxProgress state={liveState} txHash={order?.txHash ?? undefined} order />
              {order && (
                <a href={order.explorerUrl} target="_blank" rel="noreferrer" className="text-[12px] text-primary font-medium">
                  View order on CoW Explorer ↗
                </a>
              )}
            </div>
            <div>
              <KeyValue k="Shares" v={`${shares} ${asset.underlying}`} />
              <KeyValue k="Limit / share" v={formatUsd(limitNum, { precise: true })} />
              <KeyValue k={buy ? "Max total" : "Min total"} v={formatUsd(usdTotal)} />
              {order && BigInt(order.executedBuyAmount) > 0n && <KeyValue k="Filled so far" v={buy ? `${formatTokenAmount(order.executedBuyAmount, asset.decimals)} ${asset.symbol}` : formatUsd(Number(formatUnits(BigInt(order.executedBuyAmount), USDC_DECIMALS)))} />}
            </div>
            <p className="text-[12px] text-ink-muted">You can close this sheet; the order keeps working in the order book and appears under Your orders on this page and in Portfolio.</p>
          </>
        )}
      </div>
    </Sheet>
  );
}

const STATE_COPY: Record<string, string> = {
  IDLE: "",
  GETTING_FIRM_QUOTE: "Preparing the order…",
  APPROVAL_REQUIRED: "Approval needed for this amount",
  AWAITING_WALLET: "Confirm in your wallet…",
  SUBMITTED: "Order open. Solvers fill it when the market reaches your price.",
  PRECONFIRMED: "Partially filled, the rest stays open.",
  CONFIRMED: "Filled",
  FAILED: "Not placed",
};

export type { Address };
