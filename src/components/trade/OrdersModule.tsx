"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { formatUnits, type Address } from "viem";
import { useQueryClient } from "@tanstack/react-query";
import type { OrderView } from "@/domain/trade";
import { BASE_CHAIN_ID, USDC_DECIMALS } from "@/config/chain";
import { useAssets, useOrders } from "@/hooks/queries";
import { cancelSignedOrder } from "@/lib/trade/execute";
import { humanizeError } from "@/lib/errors";
import { formatTokenAmount, formatUsd, timeUntil } from "@/lib/format";
import { useNow } from "@/hooks/useNow";
import { Badge, Button, ModuleHeader } from "@/components/ui/primitives";
import { TimeAgo } from "@/components/common/TimeAgo";
import { TxLink } from "@/components/common/display";
import { COW_DOMAIN_CLIENT } from "./cow-domain";

/**
 * "Your orders": CoW limit and market orders of the connected wallet, open ones first. Cancel is
 * an offchain signature for EOAs and a small onchain transaction for smart accounts.
 */
const PAGE = 5;

export function OrdersModule({ owner, assetAddress, title = "Your orders", showEmpty = false }: { owner?: Address; assetAddress?: Address; title?: string; showEmpty?: boolean }) {
  // Ticks every 30 s so "expires in 2h" stays true while the module is open.
  const now = useNow();
  const orders = useOrders(owner);
  const assets = useAssets();
  const qc = useQueryClient();
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);

  // The CoW order book returns every order of the wallet, including pairs traded through other
  // apps; only orders on listed tokenized stocks belong here.
  const known = new Set((assets.data?.assets ?? []).map((a) => a.canonicalId));
  const list = (orders.data ?? []).filter((o) => {
    if (assets.data && (!o.assetAddress || !known.has(o.assetAddress.toLowerCase()))) return false;
    return !assetAddress || o.assetAddress?.toLowerCase() === assetAddress.toLowerCase();
  });
  const open = list.filter((o) => o.status === "open" || o.status === "presignaturePending");
  const allSettled = list.filter((o) => o.status !== "open" && o.status !== "presignaturePending");
  const settled = allSettled.slice(0, shown);
  if (!owner || (!showEmpty && list.length === 0)) return null;

  const cancel = async (o: OrderView) => {
    if (!address || !walletClient || !publicClient) return;
    setBusy(o.uid);
    setError(null);
    try {
      await cancelSignedOrder({ address, chainId, walletClient, publicClient }, { uid: o.uid, domain: COW_DOMAIN_CLIENT });
      await qc.invalidateQueries({ queryKey: ["orders", owner.toLowerCase()] });
    } catch (err) {
      setError(humanizeError(err).message);
    } finally {
      setBusy(null);
    }
  };

  const row = (o: OrderView) => {
    const asset = assets.data?.assets.find((a) => a.canonicalId === o.assetAddress?.toLowerCase());
    const decimals = asset?.decimals ?? 8;
    const buy = o.side === "buy";
    const stockAmount = buy ? o.buyAmount : o.sellAmount;
    const usdcAmount = buy ? o.sellAmount : o.buyAmount;
    const filledPct = o.executedBuyAmount !== "0" ? Math.min(100, Math.round((Number(o.executedBuyAmount) / Number(o.buyAmount)) * 100)) : 0;
    const perToken = Number(formatUnits(BigInt(usdcAmount), USDC_DECIMALS)) / Math.max(1e-12, Number(formatUnits(BigInt(stockAmount), decimals)));
    const tone = o.status === "fulfilled" ? "positive" : o.status === "open" ? "primary" : o.status === "cancelled" || o.status === "expired" ? "neutral" : "warning";
    return (
      <li key={o.uid} className="px-4 py-3 border-b border-line last:border-b-0 flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex items-center gap-2">
            <span className="text-[14px] font-medium truncate">
              {buy ? "Buy" : "Sell"} {formatTokenAmount(stockAmount, decimals)} {asset?.underlying ?? "stock"}
            </span>
            <Badge tone={tone}>{o.status === "fulfilled" ? "Filled" : o.status === "open" ? (filledPct > 0 ? `Open · ${filledPct}%` : "Open") : o.status === "presignaturePending" ? "Pending" : o.status === "cancelled" ? "Cancelled" : "Expired"}</Badge>
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">{o.orderClass}</span>
          </div>
          {o.status === "open" && (
            <Button size="sm" variant="secondary" loading={busy === o.uid} onClick={() => void cancel(o)}>
              Cancel
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-ink-secondary">
          <span className="num">{buy ? "for" : "at least"} {formatUsd(Number(formatUnits(BigInt(usdcAmount), USDC_DECIMALS)))}</span>
          <span className="num">· {formatUsd(perToken, { precise: true })} / token</span>
          <span>
            · {o.status === "open" ? <>expires {now ? timeUntil(o.validTo * 1000, now) : "…"}</> : <>placed <TimeAgo value={o.createdAt} /></>}
          </span>
          {o.txHash ? <TxLink hash={o.txHash}>Settlement ↗</TxLink> : null}
          <a href={o.explorerUrl} target="_blank" rel="noreferrer" className="text-primary font-medium">
            CoW Explorer ↗
          </a>
        </div>
      </li>
    );
  };

  return (
    <section>
      <ModuleHeader title={title} action={<span className="font-mono text-[11px] text-ink-muted">{open.length} open</span>} />
      {orders.isLoading ? (
        <p className="px-4 py-3 text-[13px] text-ink-muted">Loading orders…</p>
      ) : list.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-ink-muted">No orders yet. A limit order waits in the CoW Protocol order book until the market reaches your price.</p>
      ) : (
        <>
          <ul>
            {open.map(row)}
            {settled.map(row)}
          </ul>
          {allSettled.length > shown && (
            <button type="button" onClick={() => setShown((n) => n + PAGE)} className="w-full h-10 text-[13px] font-medium text-primary hover:bg-surface transition-fast border-t border-line">
              Show {Math.min(PAGE, allSettled.length - shown)} more · {allSettled.length - shown} older
            </button>
          )}
        </>
      )}
      {error && <p className="px-4 pb-3 text-[13px] text-danger-fg">{error}</p>}
    </section>
  );
}
