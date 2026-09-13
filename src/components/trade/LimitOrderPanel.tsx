"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { formatUnits, parseUnits, type Hash } from "viem";
import { useQueryClient } from "@tanstack/react-query";
import type { B20AssetDTO } from "@/domain/asset";
import type { TradeSide, TradeState } from "@/domain/trade";
import { apiPost, ApiError, type SignedOrderRequest } from "@/lib/client-api";
import { BASE_CHAIN_ID, USDC_DECIMALS } from "@/config/chain";
import { equityPricePerShare, parseAmountSafe, toRaw, toScaled } from "@/lib/b20/math";
import { formatTokenAmount, formatUsd } from "@/lib/format";
import { humanizeError, TRADE_ERROR_COPY, type HumanError } from "@/lib/errors";
import { executeSignedOrder } from "@/lib/trade/execute";
import { newId } from "@/lib/execution/portfolio-execution";
import { useOrderStatus } from "@/hooks/queries";
import { AmountInput } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Button, Chip, KeyValue, cx } from "@/components/ui/primitives";
import { ErrorBanner, InfoBanner } from "@/components/common/display";
import { ConnectButton } from "@/components/layout/ConnectButton";
import { ProviderMark } from "./RouteCompare";
import { TxProgress } from "./TxProgress";

interface Props {
  initialSide: TradeSide;
  asset: B20AssetDTO;
  /** Current market price per raw token (USD); the default limit is derived from it. */
  priceUsd: number | null;
  /** Raw stock balance (for sells) and USDC balance (for buys), base units. */
  rawStockBalance: bigint;
  usdcBalance: bigint;
  onPlaced?: () => void;
}

/** Order-book ceiling is 3 h (verified 2026-09-03); shorter presets suit intraday moves. */
const EXPIRIES: Array<[number, string]> = [
  [10 * 60, "10 min"],
  [30 * 60, "30 min"],
  [60 * 60, "1 h"],
  [3 * 60 * 60, "3 h"],
];
/** Quick limits relative to market: buys below, sells above. */
const OFFSETS_PCT = [1, 2, 5];

/**
 * The Limit tab of the trade panel: shares and a price per share; the signed order waits in the
 * CoW Protocol order book until a solver can execute at that price or better, or it expires.
 * Partially fillable by default so a thin pool can fill it in pieces. Amounts are
 * share-equivalents (multiplier-aware); the signed order carries raw token units.
 */
export function LimitOrderPanel({ initialSide, asset, priceUsd, rawStockBalance, usdcBalance, onPlaced }: Props) {
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });
  const qc = useQueryClient();
  const multiplier = BigInt(asset.multiplier);
  const wad = BigInt(asset.wadPrecision);
  const marketPerShare = priceUsd !== null ? equityPricePerShare(priceUsd, multiplier, wad) : null;

  const [side, setSide] = useState<TradeSide>(initialSide);
  const buy = side === "buy";
  const [shares, setShares] = useState("");
  const [limit, setLimit] = useState("");
  /** Offset preset in percent (null = typed or market). */
  const [offset, setOffset] = useState<number | null>(null);
  const [validFor, setValidFor] = useState(EXPIRIES[2]![0]);
  const [partial, setPartial] = useState(true);
  const [state, setState] = useState<TradeState>("IDLE");
  const [error, setError] = useState<HumanError | null>(null);
  const [orderUid, setOrderUid] = useState<string | undefined>();
  const [approvalHash, setApprovalHash] = useState<Hash | undefined>();
  const order = useOrderStatus(orderUid).data ?? null;

  // The market price (or a preset offset from it) is the limit until the user types one.
  const derived = marketPerShare !== null ? (offset !== null ? marketPerShare * (1 + (buy ? -offset : offset) / 100) : marketPerShare) : null;
  const limitText = limit !== "" ? limit : derived !== null ? derived.toFixed(2) : "";
  const sharesNum = Number(shares) || 0;
  const limitNum = Number(limitText) || 0;
  const usdTotal = sharesNum * limitNum;
  // Raw token units for the requested share-equivalents (scaled = raw × multiplier / WAD).
  const rawTokens = sharesNum > 0 ? toRaw(parseAmountSafe(shares, asset.decimals), multiplier, wad) : 0n;
  const usdcUnits = usdTotal > 0 ? parseUnits(usdTotal.toFixed(USDC_DECIMALS), USDC_DECIMALS) : 0n;
  const sellAmount = buy ? usdcUnits : rawTokens;
  const minBuyAmount = buy ? rawTokens : usdcUnits;
  const balance = buy ? usdcBalance : rawStockBalance;
  const insufficient = isConnected && sellAmount > balance;
  const vsMarket = marketPerShare !== null && limitNum > 0 ? ((limitNum - marketPerShare) / marketPerShare) * 100 : null;
  const crossesMarket = vsMarket !== null && (buy ? vsMarket > 0.5 : vsMarket < -0.5);
  const canPlace = sellAmount > 0n && minBuyAmount > 0n && !insufficient && state === "IDLE";
  const positionShares = (rawStockBalance * multiplier) / wad;

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
  const applyBalancePct = (p: number) => {
    if (buy) {
      if (limitNum <= 0) return;
      const usd = Number(formatUnits(usdcBalance, USDC_DECIMALS)) * (p / 100);
      setShares((usd / limitNum).toFixed(4).replace(/\.?0+$/, ""));
    } else {
      const s = Number(formatUnits(positionShares, asset.decimals)) * (p / 100);
      setShares(s.toFixed(4).replace(/\.?0+$/, ""));
    }
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
        partiallyFillable: partial,
      });
      const result = await executeSignedOrder({ address, chainId, walletClient, publicClient }, prepared, { onState: setState, onApproval: setApprovalHash });
      setOrderUid(result.orderUid);
      // The order's own record, so a fill lands in Activity, the cost basis and the statistics
      // even if this page is long closed by then; the sweep settles it from the order book.
      const orderUsd = Number(formatUnits(buy ? sellAmount : minBuyAmount, USDC_DECIMALS));
      void apiPost("/api/trades", {
        id: newId("trade"),
        owner: address,
        side,
        assetAddress: asset.address,
        sellAmount: sellAmount.toString(),
        buyAmount: minBuyAmount.toString(),
        usdValue: Math.round(orderUsd * 100) / 100,
        provider: "cow",
        orderUid: result.orderUid,
      }).catch(() => undefined);
      setState("SUBMITTED");
      void qc.invalidateQueries({ queryKey: ["orders", address.toLowerCase()] });
      onPlaced?.();
    } catch (err) {
      setError(err instanceof ApiError ? { code: (err.code in TRADE_ERROR_COPY ? err.code : "UNKNOWN") as HumanError["code"], message: err.message, detail: err.code } : humanizeError(err));
      setState("FAILED");
    }
  };

  const busy = liveState === "GETTING_FIRM_QUOTE" || liveState === "APPROVAL_REQUIRED" || liveState === "AWAITING_WALLET";
  const editing = liveState === "IDLE" || liveState === "FAILED" || busy;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
        <ProviderMark provider="cow" size={16} /> Your own price, filled gaslessly by CoW Protocol solvers.
      </div>

      {editing ? (
        <>
          <Segmented<TradeSide>
            size="sm"
            ariaLabel="Order side"
            value={side}
            onChange={(t) => {
              setSide(t);
              setOffset(null);
              setLimit("");
            }}
            options={[
              { value: "buy", label: "Buy", tone: "buy" },
              { value: "sell", label: "Sell", tone: "sell" },
            ]}
          />

          <div className="flex flex-col gap-2">
            <AmountInput value={shares} onChange={setShares} unit={`${asset.underlying} shares`} ariaLabel="Shares" />
            <div className="flex items-center justify-between gap-2 text-[12px] text-ink-secondary">
              <span className="num">{!isConnected ? "Connect to use balance presets" : buy ? `USDC balance ${formatUsd(Number(formatUnits(usdcBalance, USDC_DECIMALS)))}` : `Position ${formatTokenAmount(positionShares, asset.decimals)} ${asset.underlying}`}</span>
              <span className="flex gap-1">
                {[25, 50, 100].map((p) => (
                  <button key={p} type="button" disabled={!isConnected} onClick={() => applyBalancePct(p)} className="h-7 px-2 rounded-[6px] border border-line text-[11px] font-mono hover:border-line-strong hover:text-ink transition-fast disabled:opacity-40">
                    {p === 100 ? "Max" : `${p}%`}
                  </button>
                ))}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <AmountInput
              value={limitText}
              onChange={(v) => {
                setLimit(v);
                setOffset(null);
              }}
              unit="USD / share"
              ariaLabel="Limit price per share"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip active={offset === null && limit === ""} onClick={() => { setOffset(null); setLimit(""); }} className="h-8 min-h-[32px] px-2.5 text-[12px]">
                Market{marketPerShare !== null ? ` ${formatUsd(marketPerShare, { precise: true })}` : ""}
              </Chip>
              {OFFSETS_PCT.map((p) => (
                <Chip key={p} active={offset === p} onClick={() => { setOffset(p); setLimit(""); }} className="h-8 min-h-[32px] px-2.5 text-[12px] num" disabled={marketPerShare === null}>
                  {buy ? `−${p}%` : `+${p}%`}
                </Chip>
              ))}
              {vsMarket !== null && (
                <span className={cx("ml-auto font-mono num text-[11px]", crossesMarket ? "text-warning-fg" : "text-ink-muted")}>
                  {vsMarket >= 0 ? "+" : ""}
                  {vsMarket.toFixed(2)}% vs market
                </span>
              )}
            </div>
          </div>

          <div className="module-grid grid-cols-2">
            <div className="p-3">
              <div className="text-[11px] font-mono uppercase tracking-[0.08em] text-ink-muted">{buy ? "You pay at most" : "You receive at least"}</div>
              <div className="display num text-[20px]">{usdTotal > 0 ? formatUsd(usdTotal) : "—"}</div>
            </div>
            <div className="p-3">
              <div className="text-[11px] font-mono uppercase tracking-[0.08em] text-ink-muted">{buy ? "You receive" : "You sell"}</div>
              <div className="display num text-[20px]">{sharesNum > 0 ? `${shares} ${asset.underlying}` : "—"}</div>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-ink-secondary mr-1">Expires in</span>
              {EXPIRIES.map(([s, label]) => (
                <Chip key={s} active={validFor === s} onClick={() => setValidFor(s)} className="h-8 min-h-[32px] px-2.5 text-[12px]">
                  {label}
                </Chip>
              ))}
            </div>
            <label className="flex items-center justify-between gap-3 text-[13px] text-ink-secondary min-h-[36px]">
              <span>
                Allow partial fills <span className="text-ink-muted">· thin pools fill in pieces</span>
              </span>
              <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} className="h-4 w-4 accent-[var(--color-primary)]" />
            </label>
          </div>

          {insufficient && <p className="text-[13px] text-danger-fg">{TRADE_ERROR_COPY.INSUFFICIENT_BALANCE}</p>}
          {crossesMarket && <InfoBanner tone="warning">Your limit is {buy ? "above" : "below"} the market price, so this will likely fill right away at the market price rather than at your limit.</InfoBanner>}

          {!isConnected ? (
            <ConnectButton full size="lg" />
          ) : (
            <Button full size="lg" variant={buy ? "primary" : "ink"} disabled={!canPlace && !busy} loading={busy} onClick={() => void place()}>
              {busy ? STATE_COPY[liveState] : `Place limit ${buy ? "buy" : "sell"}${usdTotal > 0 ? ` · ${formatUsd(usdTotal)}` : ""}`}
            </Button>
          )}

          <p className="text-[12px] text-ink-muted leading-snug">
            Filled at your price or better; the solver pays the gas. Fees come out of the difference to the market price, so an order exactly at market may wait until the price moves a little. A one-time approval for this amount is a transaction. Unfilled orders expire on their own; cancel any time from Your orders.
          </p>
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
            <KeyValue k="Side" v={buy ? "Buy" : "Sell"} mono={false} />
            <KeyValue k="Shares" v={`${shares} ${asset.underlying}`} />
            <KeyValue k="Limit / share" v={formatUsd(limitNum, { precise: true })} />
            <KeyValue k={buy ? "Max total" : "Min total"} v={formatUsd(usdTotal)} />
            <KeyValue k="Expires" v={EXPIRIES.find(([s]) => s === validFor)?.[1] ?? "—"} mono={false} />
            <KeyValue k="Partial fills" v={partial ? "Allowed" : "All or nothing"} mono={false} />
            {order && BigInt(order.executedBuyAmount) > 0n && <KeyValue k="Filled so far" v={buy ? `${formatTokenAmount(toScaled(BigInt(order.executedBuyAmount), BigInt(asset.multiplier), BigInt(asset.wadPrecision)), asset.decimals)} ${asset.underlying}` : formatUsd(Number(formatUnits(BigInt(order.executedBuyAmount), USDC_DECIMALS)))} />}
          </div>
          <Button variant="secondary" full onClick={reset}>
            New order
          </Button>
          <p className="text-[12px] text-ink-muted">The order keeps working in the order book even if you leave this page; it appears under Your orders here and in Portfolio.</p>
        </>
      )}
    </div>
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
