"use client";

import { useMemo, useState } from "react";
import { useAccount, usePublicClient, useReadContracts, useWalletClient } from "wagmi";
import { encodeFunctionData, erc20Abi, formatUnits, type Address, type Hash, type Hex } from "viem";
import { base } from "viem/chains";
import { useQueryClient } from "@tanstack/react-query";
import type { EarnOpportunity } from "@/domain/earn";
import { BASE_CHAIN_ID, USDC_ADDRESS, USDC_DECIMALS } from "@/config/chain";
import { publicEnv } from "@/config/env";
import { apiPost } from "@/lib/client-api";
import { attributionCapabilities, withAttribution } from "@/lib/attribution";
import { poolTokensAbi, slipstreamMintAbi, slipstreamPoolSlot0Abi, uniswapV3MintAbi, uniswapV3PoolSlot0Abi } from "@/lib/earn/abis";
import { LP_MANAGER_INFO } from "@/lib/earn/lp-managers";
import { alignTick, amountsForOneSide, priceToTick, sqrtPriceX96ToSqrtPrice } from "@/lib/earn/lp-math";
import { equityPricePerShare, parseAmountSafe } from "@/lib/b20/math";
import { callAfterApproval, simulateBundle, walletCapabilities } from "@/lib/trade/execute";
import { humanizeError, type HumanError } from "@/lib/errors";
import { formatTokenAmount, formatUsd } from "@/lib/format";
import { qk, useAssets, useRegion } from "@/hooks/queries";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { Sheet } from "@/components/ui/Sheet";
import { AmountInput } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Button, KeyValue, cx } from "@/components/ui/primitives";
import { ErrorBanner, InfoBanner, TxLink } from "@/components/common/display";
import { RegionNotice } from "@/components/common/RegionNotice";
import { ConnectButton } from "@/components/layout/ConnectButton";

/** Everything the mint path needs, derived from an opportunity's metadata. Null = not mintable here. */
export interface MintTarget {
  pool: Address;
  npm: Address;
  kind: "v3" | "cl";
  /** v3 fee (hundredths of a bip) or Slipstream tick spacing. */
  feeOrSpacing: number;
  spacing: number;
}

const V3_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

/** USDC-quoted Uniswap v3 and Aerodrome Slipstream pools mint in-app; everything else stays on the venue. */
export function lpMintTarget(o: EarnOpportunity): MintTarget | null {
  if (o.type !== "liquidity" || o.metadata.quote !== "USDC") return null;
  const pool = o.metadata.pool as Address | undefined;
  if (!pool) return null;
  if (o.provider === "uniswap" && typeof o.metadata.fee === "number" && V3_SPACING[o.metadata.fee]) {
    const npm = LP_MANAGER_INFO.find((m) => m.id === "uniswap-v3")!.npm;
    return { pool, npm, kind: "v3", feeOrSpacing: o.metadata.fee, spacing: V3_SPACING[o.metadata.fee]! };
  }
  if (o.provider === "aerodrome" && o.metadata.kind === "cl" && typeof o.metadata.tickSpacing === "number") {
    const manager = LP_MANAGER_INFO.find((m) => m.provider === "aerodrome" && m.factory.toLowerCase() === String(o.metadata.factory ?? "").toLowerCase());
    if (!manager) return null;
    return { pool, npm: manager.npm, kind: "cl", feeOrSpacing: o.metadata.tickSpacing, spacing: o.metadata.tickSpacing };
  }
  return null;
}

type RangePreset = 5 | 10 | 25 | 0; // 0 = full range
type Phase = "idle" | "simulating" | "awaiting" | "submitted" | "done" | "failed";

const SLIPPAGE_BPS = 100n; // 1% under desired on the minimums

/**
 * Open a new concentrated-liquidity position without leaving the app. The user thinks in USD per
 * share; ticks, token order and the second amount are derived. Exact approvals to the position
 * manager only, the whole bundle is simulated before the wallet opens, minimums sit 1% under the
 * desired amounts and the deadline is 10 minutes.
 */
export function LpMintSheet({ open, onClose, opportunity, target, symbol }: { open: boolean; onClose: () => void; opportunity: EarnOpportunity; target: MintTarget; symbol: string }) {
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });
  const qc = useQueryClient();
  const region = useRegion();
  const assets = useAssets();
  const asset = assets.data?.assets.find((a) => a.address.toLowerCase() === opportunity.assetAddress.toLowerCase()) ?? null;
  const balances = useTokenBalances(address, opportunity.assetAddress);

  const reads = useReadContracts({
    allowFailure: false,
    query: { enabled: open, refetchInterval: 15_000 },
    contracts: [
      { address: target.pool, abi: poolTokensAbi, functionName: "token0" },
      { address: target.pool, abi: poolTokensAbi, functionName: "token1" },
      target.kind === "v3"
        ? { address: target.pool, abi: uniswapV3PoolSlot0Abi, functionName: "slot0" }
        : { address: target.pool, abi: slipstreamPoolSlot0Abi, functionName: "slot0" },
    ],
  });

  const [preset, setPreset] = useState<RangePreset>(10);
  const [stockText, setStockText] = useState("");
  const [usdcText, setUsdcText] = useState("");
  const [lastEdited, setLastEdited] = useState<"stock" | "usdc">("usdc");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<HumanError | null>(null);
  const [txHash, setTxHash] = useState<Hash | undefined>();

  const model = useMemo(() => {
    if (!reads.data || !asset) return null;
    const [token0, token1, slot0] = reads.data;
    const stockIs0 = token0.toLowerCase() === opportunity.assetAddress.toLowerCase();
    const quoteIs1 = stockIs0;
    if ((quoteIs1 ? token1 : token0).toLowerCase() !== USDC_ADDRESS.toLowerCase()) return null; // safety: USDC pools only
    const d0 = stockIs0 ? asset.decimals : USDC_DECIMALS;
    const d1 = stockIs0 ? USDC_DECIMALS : asset.decimals;
    const sqrtP = sqrtPriceX96ToSqrtPrice(slot0[0] as bigint);
    const currentTick = Number(slot0[1]);
    const rawPrice = sqrtP * sqrtP; // token1 per token0, raw units
    const humanT1PerT0 = rawPrice * 10 ** (d0 - d1);
    const tokenPriceUsd = stockIs0 ? humanT1PerT0 : 1 / humanT1PerT0;
    const multiplier = BigInt(asset.multiplier);
    const wad = BigInt(asset.wadPrecision);
    const perShare = equityPricePerShare(tokenPriceUsd, multiplier, wad);
    /** Tick for a given USD-per-share level of the stock. */
    const tickForShare = (share: number) => {
      const tokenPrice = share * (perShare > 0 ? tokenPriceUsd / perShare : 1);
      const h = stockIs0 ? tokenPrice : 1 / tokenPrice;
      return priceToTick(h * 10 ** (d1 - d0));
    };
    return { token0: token0 as Address, token1: token1 as Address, stockIs0, d0, d1, sqrtP, currentTick, tokenPriceUsd, perShare, multiplier, wad, tickForShare };
  }, [reads.data, asset, opportunity.assetAddress]);

  const range = useMemo(() => {
    if (!model) return null;
    const bound = Math.floor(887272 / target.spacing) * target.spacing;
    if (preset === 0) return { tickLower: -bound, tickUpper: bound, minShare: 0, maxShare: Infinity };
    const minShare = model.perShare * (1 - preset / 100);
    const maxShare = model.perShare * (1 + preset / 100);
    if (!(minShare > 0) || !(maxShare > minShare)) return null;
    const tA = model.tickForShare(minShare);
    const tB = model.tickForShare(maxShare);
    const tickLower = alignTick(Math.min(tA, tB), target.spacing, "down");
    let tickUpper = alignTick(Math.max(tA, tB), target.spacing, "up");
    if (tickUpper <= tickLower) tickUpper = tickLower + target.spacing;
    return { tickLower, tickUpper, minShare, maxShare };
  }, [model, preset, target.spacing]);

  const quoteAmounts = useMemo(() => {
    if (!model || !range || !asset) return null;
    const stockRawIn = Number(parseAmountSafe(stockText || "0", asset.decimals)) * (Number(model.wad) / Number(model.multiplier || 1n));
    const usdcRawIn = Number(parseAmountSafe(usdcText || "0", USDC_DECIMALS));
    const belowRange = model.currentTick < range.tickLower; // price under range → stock (token priced up later) side only? depends on order
    const aboveRange = model.currentTick >= range.tickUpper;
    const stockSide: "amount0" | "amount1" = model.stockIs0 ? "amount0" : "amount1";
    const usdcSide: "amount0" | "amount1" = model.stockIs0 ? "amount1" : "amount0";
    // Which token does a one-sided range need? token0 when price below range, token1 when above.
    const onlyStock = model.stockIs0 ? belowRange : aboveRange;
    const onlyUsdc = model.stockIs0 ? aboveRange : belowRange;
    const driver = onlyStock ? "stock" : onlyUsdc ? "usdc" : lastEdited;
    const given = driver === "stock" ? ({ [stockSide]: stockRawIn } as { amount0: number } | { amount1: number }) : ({ [usdcSide]: usdcRawIn } as { amount0: number } | { amount1: number });
    const r = amountsForOneSide(model.sqrtP, range.tickLower, range.tickUpper, given);
    const stockRaw = stockSide === "amount0" ? r.amount0 : r.amount1;
    const usdcRaw = usdcSide === "amount0" ? r.amount0 : r.amount1;
    return { stockRaw, usdcRaw, onlyStock, onlyUsdc, driver, liquidity: r.liquidity };
  }, [model, range, asset, stockText, usdcText, lastEdited]);

  if (!asset) return null;
  const multiplier = BigInt(asset.multiplier);
  const wad = BigInt(asset.wadPrecision);
  // Pool price vs Chainlink reference, per share: minting brackets the POOL price by necessity,
  // so a big premium/discount deserves a loud line before anyone concentrates capital around it.
  const priceView = assets.data?.prices[asset.canonicalId];
  const multNumber = Number(multiplier) / Number(wad || 1n);
  const refPerShare = priceView?.referenceUsd != null && multNumber > 0 ? priceView.referenceUsd / multNumber : null;
  const refUsable = refPerShare !== null && priceView !== undefined && !priceView.referenceStale && !priceView.referencePaused;
  const poolDeviationPct = refUsable && model && refPerShare! > 0 ? ((model.perShare - refPerShare!) / refPerShare!) * 100 : null;
  const thinPool = (opportunity.liquidityUsd ?? 0) > 0 && (opportunity.liquidityUsd ?? 0) < 10_000;
  const stockShares = quoteAmounts ? (quoteAmounts.stockRaw * Number(multiplier)) / Number(wad) / 10 ** asset.decimals : 0;
  const usdcHuman = quoteAmounts ? quoteAmounts.usdcRaw / 10 ** USDC_DECIMALS : 0;
  const totalUsd = model && quoteAmounts ? usdcHuman + (quoteAmounts.stockRaw / 10 ** asset.decimals) * model.tokenPriceUsd : 0;
  const stockBalanceRaw = Number(balances.raw);
  const usdcBalanceRaw = Number(balances.usdc);
  const insufficientStock = quoteAmounts ? quoteAmounts.stockRaw > stockBalanceRaw + 1 : false;
  const insufficientUsdc = quoteAmounts ? quoteAmounts.usdcRaw > usdcBalanceRaw + 1 : false;
  const busy = phase === "simulating" || phase === "awaiting" || phase === "submitted";
  const restricted = region.data?.restricted === true;
  const canMint = !!model && !!range && !!quoteAmounts && quoteAmounts.liquidity > 0 && !insufficientStock && !insufficientUsdc && !busy && (quoteAmounts.stockRaw > 0 || quoteAmounts.usdcRaw > 0);

  const setStock = (v: string) => {
    setStockText(v);
    setLastEdited("stock");
  };
  const setUsdc = (v: string) => {
    setUsdcText(v);
    setLastEdited("usdc");
  };
  const applyBalance = (side: "stock" | "usdc", pct: number) => {
    if (side === "stock") {
      setStock(formatUnits((balances.scaled * BigInt(pct)) / 100n, asset.decimals));
      setLastEdited("stock");
    } else {
      setUsdc(formatUnits((balances.usdc * BigInt(pct)) / 100n, USDC_DECIMALS));
      setLastEdited("usdc");
    }
  };

  const mint = async () => {
    if (!address || !walletClient || !publicClient || !model || !range || !quoteAmounts) return;
    if (chainId !== BASE_CHAIN_ID) {
      setError({ code: "WRONG_NETWORK", message: "Switch your wallet to Base to continue." });
      return;
    }
    setError(null);
    setPhase("simulating");
    try {
      const desired0 = BigInt(Math.floor(model.stockIs0 ? quoteAmounts.stockRaw : quoteAmounts.usdcRaw));
      const desired1 = BigInt(Math.floor(model.stockIs0 ? quoteAmounts.usdcRaw : quoteAmounts.stockRaw));
      const min0 = (desired0 * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      const min1 = (desired1 * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const mintData: Hex =
        target.kind === "v3"
          ? encodeFunctionData({
              abi: uniswapV3MintAbi,
              functionName: "mint",
              args: [{ token0: model.token0, token1: model.token1, fee: target.feeOrSpacing, tickLower: range.tickLower, tickUpper: range.tickUpper, amount0Desired: desired0, amount1Desired: desired1, amount0Min: min0, amount1Min: min1, recipient: address, deadline }],
            })
          : encodeFunctionData({
              abi: slipstreamMintAbi,
              functionName: "mint",
              args: [{ token0: model.token0, token1: model.token1, tickSpacing: target.feeOrSpacing, tickLower: range.tickLower, tickUpper: range.tickUpper, amount0Desired: desired0, amount1Desired: desired1, amount0Min: min0, amount1Min: min1, recipient: address, deadline, sqrtPriceX96: 0n }],
            });
      const calls: Array<{ to: Address; data: Hex }> = [];
      if (desired0 > 0n) calls.push({ to: model.token0, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [target.npm, desired0] }) });
      if (desired1 > 0n) calls.push({ to: model.token1, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [target.npm, desired1] }) });
      calls.push({ to: target.npm, data: mintData });

      await simulateBundle(publicClient, address, calls);

      const { atomic, paymaster } = await walletCapabilities(walletClient, address);

      setPhase("awaiting");
      let hash: Hash | undefined;
      if (atomic) {
        const { id } = await walletClient.sendCalls({
          account: address,
          chain: base,
          forceAtomic: true,
          calls: calls.map((c) => ({ to: c.to, data: withAttribution(c.data) })),
          capabilities: { ...attributionCapabilities(), ...(paymaster ? { paymasterService: { url: publicEnv.paymasterUrl } } : {}) },
        });
        setPhase("submitted");
        const result = await walletClient.waitForCallsStatus({ id, timeout: 180_000 });
        if (result.status === "failure") throw new Error("The transaction failed onchain.");
        hash = result.receipts?.[result.receipts.length - 1]?.transactionHash;
      } else {
        for (const c of calls) {
          if (c.to === target.npm) await callAfterApproval(publicClient, address, { to: c.to, data: c.data });
          hash = await walletClient.sendTransaction({ account: address, chain: base, to: c.to, data: withAttribution(c.data) });
          setPhase("submitted");
          await publicClient.waitForTransactionReceipt({ hash });
        }
      }
      setTxHash(hash);
      setPhase("done");
      // Activity record (never proof: the timeline and the statistics verify it against the receipt).
      // The USDC leg is the amount; the USD figure is both legs at the pool price when minted.
      if (hash) {
        const manager = LP_MANAGER_INFO.find((m) => m.npm.toLowerCase() === target.npm.toLowerCase());
        void apiPost("/api/earn/record", {
          id: `earn_${hash.slice(2, 18)}`,
          owner: address,
          opportunityId: `lp:${manager?.id ?? target.kind}:${target.pool.toLowerCase()}`,
          provider: opportunity.provider,
          action: "deposit",
          amount: BigInt(Math.floor(quoteAmounts.usdcRaw)).toString(),
          usdValue: Math.round(totalUsd * 100) / 100,
          txHash: hash,
        }).catch(() => undefined);
      }
      if (address) void qc.invalidateQueries({ queryKey: qk.lp(address) });
      balances.refetch();
    } catch (err) {
      setError(humanizeError(err));
      setPhase("failed");
    }
  };

  const reset = () => {
    setPhase("idle");
    setError(null);
    setTxHash(undefined);
  };
  const close = () => {
    reset();
    onClose();
  };

  return (
    <Sheet open={open} onClose={close} title={`Add liquidity · ${symbol} / USDC`} locked={busy}>
      {phase === "done" ? (
        <div className="flex flex-col gap-4">
          <p className="text-[14px] text-ink-secondary">Position opened. It appears under Liquidity positions (Portfolio and this stock page) with its range, value and fees — collect and withdraw live there too.</p>
          {txHash && <TxLink hash={txHash} />}
          <Button full onClick={close}>
            Done
          </Button>
        </div>
      ) : !isConnected ? (
        <div className="flex flex-col gap-3">
          <p className="text-[14px] text-ink-secondary">Connect a wallet to provide liquidity.</p>
          <ConnectButton full size="lg" />
        </div>
      ) : restricted ? (
        <RegionNotice region={region.data!} />
      ) : reads.isError ? (
        <ErrorBanner message="The pool could not be read right now." detail="RPC request failed — close and try again." />
      ) : !model || !asset ? (
        <p className="text-[14px] text-ink-secondary">Reading the pool…</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-ink-secondary">{opportunity.title}</span>
            <span className="font-mono num text-ink-secondary">{`1 ${symbol} share ≈ ${formatUsd(model.perShare, { precise: true })}`}</span>
          </div>

          {poolDeviationPct !== null && Math.abs(poolDeviationPct) >= 15 && (
            <InfoBanner tone="warning">{`This pool prices ${symbol} ${poolDeviationPct > 0 ? `${poolDeviationPct.toFixed(0)}% above` : `${Math.abs(poolDeviationPct).toFixed(0)}% below`} the stock's own price. Your range brackets the pool price — if it snaps back toward the reference, the position goes out of range and one-sided.`}</InfoBanner>
          )}
          {thinPool && <InfoBanner tone="warning">{`Nearly empty pool (≈ ${formatUsd(opportunity.liquidityUsd ?? 0)} of liquidity): its current price can be arbitrary and a single trade can move it far. Best suited to seeding, not yield.`}</InfoBanner>}

          <div className="flex flex-col gap-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Price range · USD per share</div>
            <Segmented<RangePreset>
              size="sm"
              ariaLabel="Range width"
              value={preset}
              onChange={(p) => setPreset(p)}
              options={[
                { value: 5, label: "±5%" },
                { value: 10, label: "±10%" },
                { value: 25, label: "±25%" },
                { value: 0, label: "Full range" },
              ]}
            />
            {preset === 0 ? (
              <p className="text-[12px] text-ink-muted">Full range never goes out of range but earns the thinnest fees per dollar.</p>
            ) : (
              <p className="text-[12px] text-ink-muted num">{range ? `${formatUsd(range.minShare)} – ${formatUsd(range.maxShare)} per share · earns fees only while the price stays inside` : ""}</p>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <div className={cx(quoteAmounts?.onlyUsdc && "opacity-40 pointer-events-none select-none")} aria-disabled={quoteAmounts?.onlyUsdc || undefined}>
              <AmountInput value={quoteAmounts?.onlyUsdc ? "0" : stockText} onChange={setStock} unit={`${symbol} shares`} ariaLabel={`${symbol} shares to add`} />
              <div className="mt-1 flex items-center justify-between text-[11px] text-ink-muted font-mono">
                <span>{`balance ${formatTokenAmount(balances.scaled, asset.decimals)}`}</span>
                <span className="flex gap-1">
                  {[50, 100].map((p) => (
                    <button key={p} type="button" onClick={() => applyBalance("stock", p)} className="h-6 px-1.5 rounded border border-line hover:border-line-strong">
                      {p === 100 ? "Max" : "50%"}
                    </button>
                  ))}
                </span>
              </div>
            </div>
            <div className={cx(quoteAmounts?.onlyStock && "opacity-40 pointer-events-none select-none")} aria-disabled={quoteAmounts?.onlyStock || undefined}>
              <AmountInput value={quoteAmounts?.onlyStock ? "0" : usdcText} onChange={setUsdc} unit="USDC" ariaLabel="USDC to add" />
              <div className="mt-1 flex items-center justify-between text-[11px] text-ink-muted font-mono">
                <span>{`balance ${formatUsd(Number(formatUnits(balances.usdc, USDC_DECIMALS)))}`}</span>
                <span className="flex gap-1">
                  {[50, 100].map((p) => (
                    <button key={p} type="button" onClick={() => applyBalance("usdc", p)} className="h-6 px-1.5 rounded border border-line hover:border-line-strong">
                      {p === 100 ? "Max" : "50%"}
                    </button>
                  ))}
                </span>
              </div>
            </div>
          </div>

          {quoteAmounts && (quoteAmounts.onlyStock || quoteAmounts.onlyUsdc) && (
            <InfoBanner tone="warning">{`This range sits entirely ${quoteAmounts.onlyUsdc ? "below" : "above"} the current price, so it takes only ${quoteAmounts.onlyUsdc ? "USDC" : symbol} and earns nothing until the price enters it.`}</InfoBanner>
          )}

          <div className="module-grid grid-cols-2">
            <div className="p-3">
              <div className="text-[11px] font-mono uppercase tracking-[0.08em] text-ink-muted">You deposit</div>
              <div className={cx("num text-[15px] font-medium", insufficientStock && "text-danger-fg")}>{`${stockShares.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${symbol}`}</div>
              <div className={cx("num text-[15px] font-medium", insufficientUsdc && "text-danger-fg")}>{formatUsd(usdcHuman)}</div>
            </div>
            <div className="p-3">
              <div className="text-[11px] font-mono uppercase tracking-[0.08em] text-ink-muted">Position value</div>
              <div className="display num text-[20px]">{formatUsd(totalUsd)}</div>
            </div>
          </div>

          {(insufficientStock || insufficientUsdc) && <p className="text-[13px] text-danger-fg">{`Not enough ${insufficientStock ? symbol : "USDC"} for this split — lower the amount or widen the range.`}</p>}
          {error && <ErrorBanner message={error.message} detail={error.detail} />}

          <Button full size="lg" disabled={!canMint} loading={busy} onClick={() => void mint()}>
            {busy ? PHASE_COPY[phase] : `Add liquidity${totalUsd > 0 ? ` · ${formatUsd(totalUsd)}` : ""}`}
          </Button>
          <p className="text-[12px] text-ink-muted">
            Exact approvals to the {opportunity.provider === "uniswap" ? "Uniswap" : "Aerodrome"} position manager only; the whole bundle is simulated before your wallet opens; minimums sit 1% under the shown amounts and the request expires in 10 minutes. LP earns fees but carries price-range risk: leave the range and the position turns single-sided.
          </p>
          <div>
            <KeyValue k="Pool" v={`${target.kind === "v3" ? `${(target.feeOrSpacing / 10_000).toFixed(2)}% fee` : `tick spacing ${target.feeOrSpacing}`} · ${target.pool.slice(0, 8)}…`} />
            <KeyValue k="Ticks" v={range ? `${range.tickLower} → ${range.tickUpper}` : "—"} />
          </div>
        </div>
      )}
    </Sheet>
  );
}

const PHASE_COPY: Record<Phase, string> = {
  idle: "",
  simulating: "Simulating…",
  awaiting: "Confirm in your wallet…",
  submitted: "Opening the position…",
  done: "Done",
  failed: "Try again",
};
