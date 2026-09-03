"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { encodeFunctionData, type Hash } from "viem";
import { base } from "viem/chains";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { BASE_CHAIN_ID } from "@/config/chain";
import { publicEnv } from "@/config/env";
import { attributionCapabilities, withAttribution } from "@/lib/attribution";
import { MAX_UINT128, positionManagerCommonAbi } from "@/lib/earn/abis";
import { lpManagerById } from "@/lib/earn/lp-managers";
import { humanizeError } from "@/lib/errors";
import { qk, useAssets, useLpPositions } from "@/hooks/queries";
import { formatUsd, timeAgo } from "@/lib/format";
import { Module, ModuleHeader, Badge, Button, Skeleton, cx } from "@/components/ui/primitives";
import { AssetLogo } from "@/components/common/display";
import { ProtocolLogo } from "@/components/common/ProtocolLogo";
import { LpManageSheet } from "./LpManageSheet";
import type { LpPositionDTO } from "@/lib/client-api";


const fmtAmt = (n: number) => (n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 4 : 6 }));

/**
 * Your LP positions (Aerodrome Slipstream, Uniswap v3) that hold a tokenized stock — read-only:
 * value, range, in/out-of-range and uncollected fees, managed on the venue for now.
 */
export function LpPositionsModule({ compact = false }: { compact?: boolean }) {
  const { address } = useAccount();
  const { data, isLoading, isError } = useLpPositions(address);
  const assets = useAssets();
  const [managing, setManaging] = useState<LpPositionDTO | null>(null);
  const positions = data?.positions ?? [];
  const logoOf = (addr: string) => assets.data?.assets.find((a) => a.address.toLowerCase() === addr.toLowerCase())?.logoURI;
  if (!address) return null;
  if (compact && !isLoading && positions.length === 0) return null;
  const total = positions.reduce((s, p) => s + (p.valueUsd ?? 0), 0);
  const fees = positions.reduce((s, p) => s + (p.fees.usd ?? 0), 0);
  const withFees = positions.filter((p) => p.fees.amount0 > 0 || p.fees.amount1 > 0);

  return (
    <Module>
      <ModuleHeader title="Liquidity positions" action={data ? <span className="font-mono text-[11px] text-ink-muted">read {timeAgo(data.readAt)}</span> : undefined} />
      {isLoading && !data && (
        <div className="p-4 flex flex-col gap-2">
          <Skeleton className="h-12" />
        </div>
      )}
      {isError && <p className="px-4 py-4 text-[13px] text-danger-fg">Positions could not be read.</p>}
      {data && positions.length === 0 && <p className="px-4 py-4 text-[13px] text-ink-secondary">No liquidity positions with a tokenized stock in this wallet. Pools are listed under each stock&apos;s “Earn or borrow” module.</p>}
      {positions.length > 0 && (
        <div className="px-4 py-3 border-b border-line flex flex-wrap items-center justify-between gap-3 bg-surface-muted/40">
          <div className="flex items-center gap-5">
            <span>
              <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">Total value</span>
              <span className="display num text-[16px]">{formatUsd(total)}</span>
            </span>
            <span>
              <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">Uncollected fees</span>
              <span className={cx("display num text-[16px]", fees > 0 && "text-positive-fg")}>{formatUsd(fees)}</span>
            </span>
          </div>
          <CollectAllButton positions={withFees} feesUsd={fees} />
        </div>
      )}
      {positions.map((p) => {
        const stock = [p.token0, p.token1].find((t) => t.symbol !== "USDC" && t.symbol !== "WETH") ?? p.token0;
        return (
          <div key={`${p.manager}-${p.tokenId}`} className="px-4 py-3 border-b border-line last:border-b-0 flex flex-col gap-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-[14px] inline-flex items-center gap-2">
                  <AssetLogo src={logoOf(stock.address)} symbol={stock.symbol} size={26} className="shrink-0" />
                  {p.token0.symbol} / {p.token1.symbol}
                  <span className="font-mono text-[11px] text-ink-muted">{p.provider === "uniswap" ? `${(p.feeOrTickSpacing / 10_000).toFixed(2).replace(/0$/, "")}% fee` : `tick ${p.feeOrTickSpacing}`}</span>
                </div>
                <div className="text-[12px] text-ink-secondary inline-flex items-center gap-1.5">
                  <ProtocolLogo provider={p.provider} size={14} label={p.managerLabel} withLabel className="text-[12px]" />
                  <span>· #{p.tokenId}
                  {p.rangeUsd ? (p.rangeUsd.upper > 1e9 || p.rangeUsd.lower < 1e-6 ? " · full range" : ` · range ${formatUsd(p.rangeUsd.lower)} – ${formatUsd(p.rangeUsd.upper)} per ${stock.symbol}`) : ""}</span>
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="display num text-[16px]">{p.valueUsd !== null ? formatUsd(p.valueUsd) : "—"}</div>
                <Badge tone={p.inRange ? "positive" : "warning"}>{p.inRange ? "in range" : "out of range"}</Badge>
              </div>
            </div>
            {p.rangeUsd && p.rangeUsd.upper <= 1e9 && (
              <div className="relative h-1.5 rounded-full bg-surface-muted overflow-hidden" aria-hidden>
                {(() => {
                  const span = p.rangeUsd.upper - p.rangeUsd.lower || 1;
                  const pos = Math.min(1, Math.max(0, (p.rangeUsd.current - p.rangeUsd.lower) / span));
                  return (
                    <>
                      <div className={cx("absolute inset-y-0 left-0 right-0", p.inRange ? "bg-positive-fg/30" : "bg-warning-fg/30")} />
                      <div className="absolute inset-y-0 w-0.5 bg-ink" style={{ left: `${pos * 100}%` }} />
                    </>
                  );
                })()}
              </div>
            )}
            {!p.inRange && <p className="text-[12px] text-warning-fg">Out of range: the position sits in one token and earns no fees until the price re-enters the range.</p>}
            <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-secondary font-mono">
              <span>
                {fmtAmt(p.amount0)} {p.token0.symbol} · {fmtAmt(p.amount1)} {p.token1.symbol}
              </span>
              <span>
                fees {fmtAmt(p.fees.amount0)} {p.token0.symbol} + {fmtAmt(p.fees.amount1)} {p.token1.symbol}
                {p.fees.usd !== null ? ` (${formatUsd(p.fees.usd)})` : ""}
              </span>
              <span className="inline-flex items-center gap-3">
                <button type="button" onClick={() => setManaging(p)} className="text-primary font-medium hover:underline">
                  Collect / withdraw
                </button>
                <a href={p.manageUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-ink-muted hover:text-ink">
                  {p.provider === "uniswap" ? "Uniswap" : "Aerodrome"} <ExternalLink size={12} strokeWidth={1.75} />
                </a>
              </span>
            </div>
          </div>
        );
      })}
      {positions.length > 0 && <p className="px-4 py-3 text-[12px] text-ink-muted border-t border-line">Values use current pool prices; fees are what a collect would pay right now. Collect fees and withdraw right here; opening a new position still happens on the venue.</p>}
      {managing && <LpManageSheet open onClose={() => setManaging(null)} position={managing} />}
    </Module>
  );
}


type CollectPhase = "idle" | "simulating" | "awaiting" | "submitted" | "done" | "failed";

/**
 * One click collects the uncollected fees of every position, across both managers, in a single
 * atomic batch on Base Account (sequential transactions elsewhere). Each call is simulated first.
 */
function CollectAllButton({ positions, feesUsd }: { positions: LpPositionDTO[]; feesUsd: number }) {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });
  const qc = useQueryClient();
  const [phase, setPhase] = useState<CollectPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  if (positions.length === 0) return null;
  const busy = phase === "simulating" || phase === "awaiting" || phase === "submitted";

  const run = async () => {
    if (!address || !walletClient || !publicClient) return;
    if (chainId !== BASE_CHAIN_ID) {
      setMessage("Switch your wallet to Base to collect.");
      setPhase("failed");
      return;
    }
    setMessage(null);
    setPhase("simulating");
    try {
      const calls = positions.flatMap((p) => {
        const manager = lpManagerById(p.manager);
        if (!manager) return [];
        return [{
          to: manager.npm,
          data: encodeFunctionData({ abi: positionManagerCommonAbi, functionName: "collect", args: [{ tokenId: BigInt(p.tokenId), recipient: address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }] }),
        }];
      });
      if (calls.length === 0) throw new Error("Nothing to collect.");
      for (const c of calls) await publicClient.call({ account: address, to: c.to, data: c.data });

      let atomic = false;
      let paymaster = false;
      try {
        const caps = (await walletClient.getCapabilities({ account: address, chainId: BASE_CHAIN_ID })) as { atomic?: { status?: string }; paymasterService?: { supported?: boolean } };
        atomic = caps.atomic?.status === "supported" || caps.atomic?.status === "ready";
        paymaster = !!publicEnv.paymasterUrl && !!caps.paymasterService?.supported;
      } catch {
        atomic = false;
      }

      setPhase("awaiting");
      if (atomic && calls.length > 1) {
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
      } else {
        for (const c of calls) {
          const hash: Hash = await walletClient.sendTransaction({ account: address, chain: base, to: c.to, data: withAttribution(c.data) });
          setPhase("submitted");
          await publicClient.waitForTransactionReceipt({ hash });
        }
      }
      setPhase("done");
      setMessage("Fees collected to your wallet.");
      if (address) void qc.invalidateQueries({ queryKey: qk.lp(address) });
    } catch (err) {
      setMessage(humanizeError(err).message);
      setPhase("failed");
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="secondary" loading={busy} disabled={busy || phase === "done"} onClick={() => void run()}>
        {phase === "done" ? "Collected" : busy ? (phase === "awaiting" ? "Confirm in wallet…" : "Collecting…") : `Collect all fees${feesUsd > 0 ? ` · ${formatUsd(feesUsd)}` : ""}`}
      </Button>
      {message && <span className={cx("text-[11px]", phase === "failed" ? "text-danger-fg" : "text-ink-secondary")}>{message}</span>}
    </div>
  );
}
