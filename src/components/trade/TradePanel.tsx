"use client";

import { useState } from "react";
import { useAccount, useBalance } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { Gift, ArrowUpRight } from "lucide-react";
import type { B20AssetDTO } from "@/domain/asset";
import type { PriceView } from "@/domain/market";
import type { TradeProviderId, TradeQuoteAlternative, TradeSide } from "@/domain/trade";
import type { TradeQuoteSummary } from "@/lib/client-api";
import { BASE_CHAIN_ID, DEFAULT_SLIPPAGE_BPS, NATIVE_ETH_DECIMALS, USDC_DECIMALS } from "@/config/chain";
import { parseAmountSafe, toRaw, toScaled, bpsOf } from "@/lib/b20/math";
import { formatTokenAmount, formatUsd, formatPct } from "@/lib/format";
import { useTradePrice } from "@/hooks/useTradePrice";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { useBestExecution, useSlippage } from "@/hooks/useSettings";
import { useResolveRecipient, useAssets, useRegion } from "@/hooks/queries";
import { AmountInput, Input } from "@/components/ui/Input";
import { Button, KeyValue, cx } from "@/components/ui/primitives";
import { Slider } from "@/components/ui/Slider";
import { Collapsible } from "@/components/ui/Collapsible";
import { RecipientCard } from "@/components/common/RecipientCard";
import { FundWallet } from "@/components/common/FundWallet";
import { RegionNotice } from "@/components/common/RegionNotice";
import { ColorDot } from "@/components/common/AllocationBar";
import { ConnectButton } from "@/components/layout/ConnectButton";
import { TradeReviewSheet } from "./TradeReviewSheet";
import { LimitOrderPanel } from "./LimitOrderPanel";
import { RouteCompare, PROVIDER_LABEL, ProviderMark } from "./RouteCompare";
import { BestExecutionSwitch } from "./BestExecutionSwitch";
import { Segmented } from "@/components/ui/Segmented";
import { SlippageControl } from "./SlippageControl";
import { TRADE_ERROR_COPY } from "@/lib/errors";
import { isNotIssued, tradingStatus, MAX_LEG_POOL_SHARE } from "@/lib/trading-status";

const PCT_CHIPS = [25, 50, 75, 100];

/**
 * ETH pays its own gas, so "Max" cannot be the whole balance: a swap for everything leaves nothing
 * to pay for itself and the wallet refuses it. A flat 0.0005 ETH covers a swap on Base many times
 * over at today's gas; the presets below 100% leave far more than that anyway.
 */
const ETH_GAS_RESERVE_WEI = 500_000_000_000_000n;

interface Props {
  asset: B20AssetDTO;
  price: PriceView | null;
  initialSide?: TradeSide;
  onTraded?: () => void;
  className?: string;
}

/** The most important interaction in the app: amount first, live executable quote, sticky CTA. */
export function TradePanel({ asset, price, initialSide = "buy", onTraded, className }: Props) {
  const { address, isConnected } = useAccount();
  const [side, setSide] = useState<TradeSide>(initialSide);
  const [limitMode, setLimitMode] = useState(false);
  const [usd, setUsd] = useState<string>("25");
  const [shares, setShares] = useState<string>("");
  const [pct, setPctState] = useState<number>(0);
  /** Balance percentage preset for buys (null = typed amount). */
  const [buyPct, setBuyPct] = useState<number | null>(null);
  const [review, setReview] = useState(false);
  const [giftMode, setGiftMode] = useState(false);
  const [payWith, setPayWith] = useState<"USDC" | "ETH">("USDC");
  /** null = automatic (best net output); otherwise the provider the user picked in the comparison. */
  const [providerChoice, setProviderChoice] = useState<TradeProviderId | null>(null);
  const bestExecution = useBestExecution();
  const { data: assetsData } = useAssets();
  const region = useRegion();
  const restricted = region.data?.restricted === true;
  const ethUsd = assetsData?.ethUsd ?? null;
  // The one balance still read from the browser (it is not in the portfolio snapshot). It moves
  // only when its owner transacts, so it is polled as a safety net, not as a live feed.
  const ethBalance = useBalance({ address, chainId: BASE_CHAIN_ID, query: { enabled: !!address, staleTime: 60_000, refetchInterval: 120_000 } });
  const ethWei = ethBalance.data?.value ?? 0n;
  const [recipientInput, setRecipientInput] = useState("");
  const { slippageBps } = useSlippage();
  const balances = useTokenBalances(address, asset.address);
  const resolve = useResolveRecipient(giftMode ? recipientInput : "");
  const recipient = giftMode ? (resolve.data?.resolved ?? null) : null;
  const multiplier = BigInt(asset.multiplier);
  const wad = BigInt(asset.wadPrecision);

  const [seenInitialSide, setSeenInitialSide] = useState(initialSide);
  if (initialSide !== seenInitialSide) {
    setSeenInitialSide(initialSide);
    setSide(initialSide);
  }

  const payEth = side === "buy" && payWith === "ETH";
  const usdInput = Number(usd || 0);
  /** What was typed, before any clamp: the balance test below has to see this number, not the clamped one. */
  const typedSellAmount = payEth ? (ethUsd && usdInput > 0 ? parseUnits((usdInput / ethUsd).toFixed(NATIVE_ETH_DECIMALS), NATIVE_ETH_DECIMALS) : 0n) : computeSellAmount(side, usd, shares, asset.decimals, multiplier, wad);
  // A sell for more than the position is quoted at the position (the only amount that can actually
  // be sold) and says so below; the typed amount still fails the balance test, so the CTA stays off
  // until the user takes the cap. Clamping silently used to mean a sell could never be "insufficient".
  const sellCapped = side === "sell" && isConnected && !balances.isLoading && typedSellAmount > balances.raw;
  const sellAmount = sellCapped ? balances.raw : typedSellAmount;
  const priceState = useTradePrice(sellAmount > 0n && !restricted && !isNotIssued(asset) && (!giftMode || !!recipient) ? { side, payWith: side === "buy" ? payWith : undefined, assetAddress: asset.address, sellAmount, taker: address, recipient: recipient?.address, slippageBps, bestExecution: bestExecution.enabled } : null);
  const s = priceState.summary;
  const chosenAlt = providerChoice && s?.alternatives ? (s.alternatives.find((a) => a.provider === providerChoice && a.buyAmount) ?? null) : null;
  /** What the panel and the review show: the best quote, or the chosen provider's numbers. */
  const view = s && chosenAlt ? withAlternative(s, chosenAlt) : s;
  const paused = asset.status === "paused";
  const insufficient = side === "buy" ? isConnected && sellAmount > (payEth ? ethWei : balances.usdc) : isConnected && typedSellAmount > balances.raw;
  const usdcBalanceUsd = Number(formatUnits(balances.usdc, USDC_DECIMALS));
  const ethBalanceUsd = ethUsd ? Number(formatUnits(ethWei, NATIVE_ETH_DECIMALS)) * ethUsd : 0;
  const payBalanceUsd = payEth ? ethBalanceUsd : usdcBalanceUsd;
  const spendableEthWei = ethWei > ETH_GAS_RESERVE_WEI ? ethWei - ETH_GAS_RESERVE_WEI : 0n;
  /** What the balance presets divide: the USDC balance, or the ETH balance less the gas it will need. */
  const spendableUsd = payEth ? (ethUsd ? Number(formatUnits(spendableEthWei, NATIVE_ETH_DECIMALS)) * ethUsd : 0) : usdcBalanceUsd;
  const status = tradingStatus(asset, price);
  const displayPrice = price?.displayUsd ?? null;
  const buySliderMax = isConnected && payBalanceUsd >= 1 ? Math.floor(payBalanceUsd) : 1000;
  const usdNumber = Number(usd || 0);

  // Quotes are in raw token units; the position and every balance on the page are share-equivalents (raw × multiplier).
  const estimateShares = view && side === "buy" ? formatTokenAmount(toScaled(BigInt(view.buyAmount), multiplier, wad), asset.decimals) : null;
  const estimateUsdNumber = view && side === "sell" ? Number(formatUnits(BigInt(view.buyAmount), USDC_DECIMALS)) : null;

  const setPct = (p: number) => {
    setPctState(p);
    const raw = bpsOf(balances.raw, Math.round(p * 100));
    const scaled = (raw * multiplier) / wad;
    setShares(formatUnits(scaled, asset.decimals));
  };

  const ctaLabel = paused
    ? "Transfers paused"
    : side === "buy"
      ? `${giftMode ? "Review gift" : "Buy"} ${asset.underlying}${usdNumber > 0 ? ` · ${formatUsd(usdNumber)}` : ""}`
      : `Sell ${asset.underlying}${estimateUsdNumber !== null ? ` · ≈ ${formatUsd(estimateUsdNumber)}` : ""}`;
  const canReview = !!s && s.liquidityAvailable && sellAmount > 0n && !insufficient && !paused && priceState.status === "ready" && (!giftMode || !!recipient);

  return (
    <div className={cx("flex flex-col", className)}>
      <div className="p-3 border-b border-line flex items-center gap-2">
        <Segmented<"buy" | "sell" | "limit">
          className="flex-1 min-w-0"
          ariaLabel="Trade mode"
          value={limitMode ? "limit" : side}
          onChange={(t) => {
            if (t === "limit") {
              setLimitMode(true);
              return;
            }
            setLimitMode(false);
            setSide(t);
            setProviderChoice(null);
          }}
          options={[
            { value: "buy", label: "Buy", tone: "buy" },
            { value: "sell", label: "Sell", tone: "sell" },
            { value: "limit", label: "Limit", title: restricted ? "Not available in your region" : "Your own price, filled gaslessly by CoW Protocol", disabled: restricted },
          ]}
        />
      </div>

      <div className="p-4 flex flex-col gap-4">
        <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
          <ColorDot k={asset.address} /> {asset.underlying} · {displayPrice !== null ? formatUsd(displayPrice) : "—"} <span className="text-ink-muted">{price?.displaySource === "reference" ? "reference" : "market"}</span>
        </div>

        {limitMode ? (
          <LimitOrderPanel initialSide={side} asset={asset} priceUsd={displayPrice} rawStockBalance={balances.raw} usdcBalance={balances.usdc} onPlaced={() => onTraded?.()} />
        ) : (
          <>
        {side === "buy" ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12px] text-ink-secondary">Pay with</span>
              <Segmented<"USDC" | "ETH">
                size="sm"
                className="w-[150px]"
                ariaLabel="Pay with"
                value={payWith}
                onChange={setPayWith}
                options={[
                  { value: "USDC", label: "USDC" },
                  { value: "ETH", label: "ETH" },
                ]}
              />
            </div>
            <AmountInput value={usd} onChange={(v) => { setUsd(v);  setBuyPct(null); }} unit="USD" ariaLabel="Amount in US dollars" />
            <Slider value={Math.min(buySliderMax, usdNumber)} min={0} max={buySliderMax} step={1} onChange={(v) => { setUsd(String(v));  setBuyPct(null); }} ariaLabel="Buy amount slider" marks={["$0", formatUsd(buySliderMax / 2), isConnected && payBalanceUsd >= 1 ? "Balance" : formatUsd(buySliderMax)]} />
            <Segmented<number>
              size="sm"
              ariaLabel="Share of balance to spend"
              value={buyPct}
              onChange={(p) => {
                setBuyPct(p);
                const amount = Math.floor(spendableUsd * p) / 100;
                setUsd(amount > 0 ? amount.toFixed(2).replace(/\.00$/, "") : "0");
              }}
              options={[25, 50, 75, 100].map((p) => ({ value: p, label: p === 100 ? "Max" : `${p}%`, disabled: !isConnected || payBalanceUsd < 1, title: !isConnected ? "Connect a wallet to use balance presets" : payBalanceUsd < 1 ? "No balance to spend" : `${p}% of your ${payEth ? "ETH balance, less a gas reserve" : "USDC balance"}` }))}
            />
            <div className="flex items-center justify-between text-[13px] text-ink-secondary">
              <span>{payEth ? "ETH balance" : "USDC balance"}</span>
              <span className="font-mono num">{!isConnected ? "—" : payEth ? `${formatTokenAmount(ethWei, NATIVE_ETH_DECIMALS)} ETH · ≈ ${formatUsd(ethBalanceUsd)}` : formatUsd(usdcBalanceUsd)}</span>
            </div>
            {payEth && sellAmount > 0n && <p className="text-[12px] text-ink-muted">≈ {formatTokenAmount(sellAmount, NATIVE_ETH_DECIMALS, 6)} ETH at {ethUsd ? formatUsd(ethUsd) : "—"} per ETH. No approval needed; ETH is sent with the swap.</p>}
            {/*
              Shown when the wallet is empty and also when it is merely short: telling somebody the
              balance will not cover this trade and offering no way to fix it is the worst of both.
              `insufficient` is the same test the error message below uses.
            */}
            {isConnected && !balances.isLoading && (insufficient || (payEth ? ethWei === 0n : balances.usdc === 0n)) && (
              <FundWallet compact onPayWithEth={!payEth ? () => setPayWith("ETH") : undefined} ethAvailable={ethWei > 0n} />
            )}
            <button type="button" onClick={() => setGiftMode((g) => !g)} aria-pressed={giftMode} className={cx("self-start inline-flex items-center gap-2 h-9 px-3 rounded-[6px] border text-[13px] font-medium transition-fast", giftMode ? "border-primary text-primary bg-primary-soft" : "border-line text-ink-secondary hover:text-ink hover:border-line-strong")}>
              <Gift size={14} strokeWidth={1.75} /> {giftMode ? "Buying for someone else" : "Buy for someone else"}
            </button>
            {giftMode && (
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
                    ) : recipient ? (
                      <RecipientCard r={recipient} compact />
                    ) : (
                      "Not found. Check the Basename or paste a 0x address."
                    )
                  ) : (
                    "The stock is delivered straight to the recipient's wallet."
                  )
                }
              />
            )}
          </>
        ) : (
          <>
            <AmountInput value={shares} onChange={(v) => { setShares(v); setPctState(0); }} unit={asset.underlying} ariaLabel={`Amount of ${asset.underlying} shares`} />
            <Slider value={pct} min={0} max={100} step={1} onChange={setPct} ariaLabel="Percentage of position to sell" disabled={!isConnected || balances.raw === 0n} marks={["0%", "50%", "Max"]} valueLabel={`${pct}%`} />
            <Segmented<number>
              size="sm"
              ariaLabel="Share of position to sell"
              value={PCT_CHIPS.includes(pct) ? pct : null}
              onChange={setPct}
              options={PCT_CHIPS.map((p) => ({ value: p, label: p === 100 ? "Max" : `${p}%`, disabled: !isConnected || balances.raw === 0n, title: !isConnected ? "Connect a wallet to use position presets" : undefined }))}
            />
            <div className="flex items-center justify-between text-[13px] text-ink-secondary">
              <span>Your position</span>
              <span className="font-mono num">{isConnected ? `${formatTokenAmount(balances.scaled, asset.decimals)} ${asset.underlying}` : "—"}</span>
            </div>
            {sellCapped && (
              <p className="text-[12px] text-warning-fg">
                {balances.raw === 0n ? `You hold no ${asset.underlying} to sell.` : `Quote capped to your balance: ${formatTokenAmount(balances.scaled, asset.decimals)} ${asset.underlying}. Enter up to that, or press Max.`}
              </p>
            )}
          </>
        )}

        {isNotIssued(asset) && (
          <p className="text-[12px] text-ink-secondary border border-dashed border-warning-fg/50 rounded-[6px] px-3 py-2">
            Not issued onchain yet: Coinbase has not minted {asset.underlying} on Base, so no pool exists and no route can fill an order. The contract is live and unpaused; trading opens automatically once supply appears. Add it to your watchlist meanwhile.
          </p>
        )}
        {price?.deviationPct !== null && price?.deviationPct !== undefined && Math.abs(price.deviationPct) >= 15 && !price.referenceStale && !price.referencePaused && (
          <p className="text-[12px] border border-dashed border-warning-fg/60 text-warning-fg rounded-[6px] px-3 py-2">
            {`The pool prices ${asset.underlying} ${price.deviationPct > 0 ? `${price.deviationPct.toFixed(0)}% above` : `${Math.abs(price.deviationPct).toFixed(0)}% below`} the stock's own price. You ${side === "buy" ? "buy" : "sell"} at the pool price${price.deviationPct > 0 ? " — a premium this large can shrink at any time, whatever the stock does" : ""}.`}
          </p>
        )}
        {/* The same status and thresholds the list and the cards use, so a stock is "thin" here iff it is "thin" there; the size hint is the batched-leg line (a share of the pool), not a number of its own. */}
        {(status.status === "thin" || status.status === "very-thin") && (
          <p className="text-[12px] text-ink-muted border border-dashed border-line rounded-[6px] px-3 py-2">
            {status.label} market: {status.detail} for {asset.underlying}. Orders above roughly {formatUsd(Math.max(1, (price?.liquidityUsd ?? 0) * MAX_LEG_POOL_SHARE))} ({(MAX_LEG_POOL_SHARE * 100).toFixed(0)}% of the pool) start moving the price against you.
          </p>
        )}
        <div className="border-t border-line pt-3 min-h-[92px]" aria-live="polite">
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Live quote</span>
            <SlippageControl />
          </div>
          {sellAmount === 0n && <p className="text-[13px] text-ink-muted">Enter an amount to see a live quote.</p>}
          {sellAmount > 0n && giftMode && !recipient && <p className="text-[13px] text-ink-muted">Add a recipient to get a quote.</p>}
          {sellAmount > 0n && priceState.status === "loading" && !s && <p className="text-[13px] text-ink-muted">Finding the best price…</p>}
          {priceState.status === "error" && <p className="text-[13px] text-danger-fg">{priceState.error?.code && priceState.error.code in TRADE_ERROR_COPY ? priceState.error.message : "Price unavailable right now."}</p>}
          {view && (
            <div className={cx(priceState.status === "loading" && "opacity-60 transition-fast")}>
              <div className="flex items-baseline justify-between">
                <span className="text-[13px] text-ink-secondary">{recipient ? "Recipient gets (est.)" : "You receive (est.)"}</span>
                <span className="display num text-[22px]">{side === "buy" ? `${estimateShares} ${asset.underlying}` : formatUsd(estimateUsdNumber)}</span>
              </div>
              <KeyValue
                k="Route"
                v={
                  <span className="inline-flex items-center gap-1.5 max-w-full">
                    <ProviderMark provider={view.provider} size={14} />
                    <span className="truncate">{`${PROVIDER_LABEL[view.provider] ?? view.provider}${chosenAlt ? " · your choice" : s?.execution?.applied ? " · best execution" : " · best net"}${view.route.length ? ` · ${routeLabel(view.route)}` : ""}`}</span>
                  </span>
                }
              />
              <KeyValue k="Executable price" v={view.executablePricePerShareUsd !== null ? `${formatUsd(view.executablePricePerShareUsd, { precise: true })} / share` : "—"} />
              {/* Impact is what this trade does to the pool; the gap to the Chainlink reference is the pool's premium or discount. Without a trusted pool price the impact figure is itself the gap. */}
              <KeyValue k={view.priceImpactBasis === "market" ? "Price impact" : "vs reference"} v={view.priceImpactPct !== null ? formatPct(view.priceImpactPct, { sign: true }) : "—"} />
              {view.priceImpactBasis === "market" && view.referenceGapPct !== null && view.referenceGapPct !== undefined && <KeyValue k="vs reference" v={formatPct(view.referenceGapPct, { sign: true })} />}
              <KeyValue k="Est. network fee" v={view.estimatedNetworkFeeUsd !== null ? `${view.networkFeeEstimated ? "≈ " : ""}${formatUsd(view.estimatedNetworkFeeUsd, { precise: true })}` : "—"} />
              {view.integratorFee && <KeyValue k={`BaseStocks fee · ${(view.integratorFee.bps / 100).toFixed(2)}%`} v={view.integratorFee.usd !== null ? `${formatUsd(view.integratorFee.usd, { precise: true })} · included above` : "included above"} />}
              {insufficient && <p className="mt-1 text-[13px] text-danger-fg">{TRADE_ERROR_COPY.INSUFFICIENT_BALANCE}</p>}
              {!view.liquidityAvailable && <p className="mt-1 text-[13px] text-danger-fg">{TRADE_ERROR_COPY.ROUTE_UNAVAILABLE}</p>}
              {view.warnings.map((w) => (
                <p key={w} className="mt-1 text-[12px] text-ink-muted">
                  {w}
                </p>
              ))}
            </div>
          )}
        </div>

        {restricted ? (
          <RegionNotice region={region.data!} />
        ) : !isConnected ? (
          <ConnectButton full size="lg" />
        ) : (
          <Button full size="lg" variant={side === "buy" ? "primary" : "ink"} disabled={!canReview || isNotIssued(asset)} onClick={() => setReview(true)}>
            {ctaLabel} <ArrowUpRight size={16} strokeWidth={1.75} />
          </Button>
        )}

        <BestExecutionSwitch enabled={bestExecution.enabled} onChange={bestExecution.set} advice={chosenAlt ? null : (s?.execution ?? null)} manual={!!chosenAlt} />
        {s?.alternatives && s.alternatives.length > 1 && <RouteCompare alternatives={s.alternatives} side={side} asset={asset} selected={providerChoice} onSelect={setProviderChoice} loading={priceState.status === "loading"} />}
        <Collapsible title="Execution details">
          <KeyValue k="Market price" v={displayPrice !== null ? formatUsd(displayPrice, { precise: true }) : "—"} />
          <KeyValue k="Buy now / Sell now · per token" v={view?.executablePriceUsd !== null && view?.executablePriceUsd !== undefined ? formatUsd(view.executablePriceUsd, { precise: true }) : "—"} />
          <KeyValue k="Route" v={view?.route.length ? view.route.map((r) => r.source).join(", ") : "—"} />
          <KeyValue k="Provider" v={view ? `${PROVIDER_LABEL[view.provider] ?? view.provider}${chosenAlt ? " · your choice" : s?.execution?.applied ? " · best execution" : " · best net"}` : "—"} />
          <KeyValue k="Slippage tolerance" v={`${(slippageBps / 100).toFixed(2)}%`} />
          <KeyValue k="Multiplier" v={formatUnits(multiplier, 18)} />
          <KeyValue k="Sell amount (raw units)" v={sellAmount.toString()} />
        </Collapsible>
          </>
        )}
      </div>

      {view && (
        <TradeReviewSheet
          provider={providerChoice ?? undefined}
          strictProvider={!!chosenAlt}
          bestExecution={!chosenAlt && bestExecution.enabled}
          payWith={side === "buy" ? payWith : undefined}
          payUsd={usdInput}
          open={review}
          onClose={() => setReview(false)}
          onDone={() => {
            balances.refetch();
            onTraded?.();
          }}
          side={side}
          asset={asset}
          summary={view}
          sellAmount={sellAmount}
          recipient={recipient ?? undefined}
          slippageBps={slippageBps ?? DEFAULT_SLIPPAGE_BPS}
        />
      )}
    </div>
  );
}

/** At most two hop names in the quote line; the full list lives under Execution details. */
function routeLabel(route: Array<{ source: string }>): string {
  const names = route.map((r) => r.source);
  return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

/** The typed amount in base units of what is sold: USDC for a buy, raw stock units for a sell (the input is in share-equivalents). */
function computeSellAmount(side: TradeSide, usd: string, shares: string, decimals: number, multiplier: bigint, wad: bigint): bigint {
  if (side === "buy") return parseAmountSafe(usd, USDC_DECIMALS);
  const scaled = parseAmountSafe(shares, decimals);
  if (scaled === 0n) return 0n;
  return toRaw(scaled, multiplier, wad);
}

export function usdcToUsd(v: bigint): number {
  return Number(formatUnits(v, USDC_DECIMALS));
}

export function usdToUsdc(v: number): bigint {
  return parseUnits(v.toFixed(USDC_DECIMALS), USDC_DECIMALS);
}

/** Re-express the summary with a manually chosen provider's indicative numbers (same basis price). */
function withAlternative(s: TradeQuoteSummary, a: TradeQuoteAlternative): TradeQuoteSummary {
  if (!a.buyAmount) return s;
  const signedImpact = s.priceImpactPct === null ? null : s.side === "buy" ? s.priceImpactPct : -s.priceImpactPct;
  const basis = s.executablePriceUsd !== null && signedImpact !== null ? s.executablePriceUsd / (1 + signedImpact / 100) : null;
  const exec = a.executablePriceUsd;
  const sign = s.side === "buy" ? 1 : -1;
  const against = (basisPrice: number | null) => (exec !== null && basisPrice !== null && basisPrice > 0 ? sign * ((exec - basisPrice) / basisPrice) * 100 : null);
  const priceImpactPct = against(basis);
  // The reference price is recovered the same way from the best quote's gap, so the chosen route's gap is measured against the same number.
  const reference = s.executablePriceUsd !== null && s.referenceGapPct !== null && s.referenceGapPct !== undefined ? s.executablePriceUsd / (1 + (sign * s.referenceGapPct) / 100) : null;
  return {
    ...s,
    provider: a.provider,
    buyAmount: a.buyAmount,
    minBuyAmount: null,
    executablePriceUsd: exec,
    executablePricePerShareUsd: exec !== null && s.executablePriceUsd !== null && s.executablePriceUsd > 0 && s.executablePricePerShareUsd !== null ? (exec * s.executablePricePerShareUsd) / s.executablePriceUsd : null,
    priceImpactPct,
    referenceGapPct: against(reference),
    estimatedNetworkFeeWei: null,
    estimatedNetworkFeeUsd: a.estimatedNetworkFeeUsd,
    networkFeeEstimated: a.networkFeeEstimated,
    route: a.route ? a.route.split(", ").map((source) => ({ source, proportionBps: null })) : [],
    allowanceSpender: null,
  };
}
