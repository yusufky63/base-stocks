"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { encodeFunctionData, type Hash } from "viem";
import { base } from "viem/chains";
import { useQueryClient } from "@tanstack/react-query";
import type { LpPositionDTO } from "@/lib/client-api";
import { BASE_CHAIN_ID } from "@/config/chain";
import { publicEnv } from "@/config/env";
import { attributionCapabilities, withAttribution } from "@/lib/attribution";
import { MAX_UINT128, positionManagerCommonAbi } from "@/lib/earn/abis";
import { lpManagerById } from "@/lib/earn/lp-managers";
import { humanizeError, type HumanError } from "@/lib/errors";
import { formatUsd } from "@/lib/format";
import { qk } from "@/hooks/queries";
import { Sheet } from "@/components/ui/Sheet";
import { Segmented } from "@/components/ui/Segmented";
import { Button, KeyValue } from "@/components/ui/primitives";
import { ErrorBanner, TxLink } from "@/components/common/display";

const fmtAmt = (n: number) => (n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 4 : 6 }));

/** Withdrawal slippage guard: minimums are 1% under the currently backing amounts. */
const MIN_OUT_BPS = 9_900n;

type Phase = "idle" | "simulating" | "awaiting" | "submitted" | "done" | "failed";

/**
 * Manage a concentrated-liquidity position in-app: collect the uncollected fees, or withdraw a
 * share of the liquidity (decreaseLiquidity + collect, batched atomically on Base Account).
 * Minting new positions still happens on the venue; this covers the exits.
 */
export function LpManageSheet({ open, onClose, position }: { open: boolean; onClose: () => void; position: LpPositionDTO }) {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });
  const qc = useQueryClient();

  const [pct, setPct] = useState<number>(100);
  const [phase, setPhase] = useState<Phase>("idle");
  const [action, setAction] = useState<"collect" | "withdraw" | null>(null);
  const [error, setError] = useState<HumanError | null>(null);
  const [txHash, setTxHash] = useState<Hash | undefined>();

  const manager = lpManagerById(position.manager);
  const tokenId = BigInt(position.tokenId);
  const hasFees = position.fees.amount0 > 0 || position.fees.amount1 > 0;
  const liquidity = BigInt(position.liquidity);
  const busy = phase === "simulating" || phase === "awaiting" || phase === "submitted";

  const reset = () => {
    setPhase("idle");
    setAction(null);
    setError(null);
    setTxHash(undefined);
  };
  const close = () => {
    reset();
    onClose();
  };
  const finish = (hash: Hash | undefined) => {
    setTxHash(hash);
    setPhase("done");
    if (address) void qc.invalidateQueries({ queryKey: qk.lp(address) });
  };

  const run = async (what: "collect" | "withdraw") => {
    if (!address || !walletClient || !publicClient || !manager) return;
    if (chainId !== BASE_CHAIN_ID) {
      setError({ code: "WRONG_NETWORK", message: "Switch your wallet to Base to continue." });
      return;
    }
    setAction(what);
    setError(null);
    setPhase("simulating");
    try {
      const collectData = encodeFunctionData({
        abi: positionManagerCommonAbi,
        functionName: "collect",
        args: [{ tokenId, recipient: address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
      });
      const calls: Array<{ to: `0x${string}`; data: `0x${string}` }> = [];
      if (what === "withdraw") {
        const share = (liquidity * BigInt(pct)) / 100n;
        if (share === 0n) throw new Error("Nothing to withdraw at this percentage.");
        const min0 = (BigInt(Math.floor(position.amount0 * 10 ** position.token0.decimals)) * BigInt(pct) * MIN_OUT_BPS) / (100n * 10_000n);
        const min1 = (BigInt(Math.floor(position.amount1 * 10 ** position.token1.decimals)) * BigInt(pct) * MIN_OUT_BPS) / (100n * 10_000n);
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
        calls.push({
          to: manager.npm,
          data: encodeFunctionData({ abi: positionManagerCommonAbi, functionName: "decreaseLiquidity", args: [{ tokenId, liquidity: share, amount0Min: min0, amount1Min: min1, deadline }] }),
        });
      }
      calls.push({ to: manager.npm, data: collectData });

      // Simulate the exact sequence before the wallet opens; managers revert loudly on bad params.
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
      let hash: Hash | undefined;
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
        hash = result.receipts?.[result.receipts.length - 1]?.transactionHash;
      } else {
        for (const c of calls) {
          hash = await walletClient.sendTransaction({ account: address, chain: base, to: c.to, data: withAttribution(c.data) });
          setPhase("submitted");
          await publicClient.waitForTransactionReceipt({ hash });
        }
      }
      finish(hash);
    } catch (err) {
      setError(humanizeError(err));
      setPhase("failed");
    }
  };

  const withdrawPreview = {
    amount0: (position.amount0 * pct) / 100,
    amount1: (position.amount1 * pct) / 100,
    usd: position.valueUsd !== null ? (position.valueUsd * pct) / 100 : null,
  };

  return (
    <Sheet open={open} onClose={close} title={`${position.token0.symbol} / ${position.token1.symbol} · #${position.tokenId}`} locked={busy}>
      {phase === "done" ? (
        <div className="flex flex-col gap-4">
          <p className="text-[14px] text-ink-secondary">{action === "collect" ? "Fees collected to your wallet." : `${pct}% of the position withdrawn — principal and all fees are in your wallet.`}</p>
          {txHash && <TxLink hash={txHash} />}
          <Button full onClick={close}>
            Done
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <div>
            <KeyValue k="Position" v={`${fmtAmt(position.amount0)} ${position.token0.symbol} + ${fmtAmt(position.amount1)} ${position.token1.symbol}`} />
            <KeyValue k="Value" v={position.valueUsd !== null ? formatUsd(position.valueUsd) : "—"} />
            <KeyValue k="Uncollected fees" v={`${fmtAmt(position.fees.amount0)} ${position.token0.symbol} + ${fmtAmt(position.fees.amount1)} ${position.token1.symbol}${position.fees.usd !== null ? ` (${formatUsd(position.fees.usd)})` : ""}`} />
            <KeyValue k="Manager" v={position.managerLabel} mono={false} />
          </div>

          <div className="flex flex-col gap-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Collect fees</div>
            <Button variant="secondary" full disabled={!hasFees || busy} loading={busy && action === "collect"} onClick={() => void run("collect")}>
              {hasFees ? `Collect${position.fees.usd !== null ? ` ${formatUsd(position.fees.usd)}` : ""} in fees` : "No fees to collect yet"}
            </Button>
          </div>

          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Withdraw liquidity</div>
            <Segmented<number>
              size="sm"
              ariaLabel="Share of the position to withdraw"
              value={pct}
              onChange={setPct}
              options={[25, 50, 75, 100].map((p) => ({ value: p, label: p === 100 ? "All" : `${p}%` }))}
            />
            <p className="text-[13px] text-ink-secondary">
              {`You receive ≈ ${fmtAmt(withdrawPreview.amount0)} ${position.token0.symbol} + ${fmtAmt(withdrawPreview.amount1)} ${position.token1.symbol}`}
              {withdrawPreview.usd !== null ? ` (${formatUsd(withdrawPreview.usd)})` : ""}, plus every uncollected fee.
            </p>
            <Button full disabled={busy || liquidity === 0n} loading={busy && action === "withdraw"} onClick={() => void run("withdraw")}>
              {busy && action === "withdraw" ? PHASE_COPY[phase] : `Withdraw ${pct === 100 ? "everything" : `${pct}%`}`}
            </Button>
            <p className="text-[12px] text-ink-muted">Simulated first; minimum amounts are set 1% under the current backing, so a moving pool reverts instead of short-changing you. On Base Account the withdraw and the fee collect land as one atomic transaction. The empty position NFT stays in your wallet after a full exit.</p>
          </div>

          {error && <ErrorBanner message={error.message} detail={error.detail} />}
        </div>
      )}
    </Sheet>
  );
}

const PHASE_COPY: Record<Phase, string> = {
  idle: "",
  simulating: "Simulating…",
  awaiting: "Confirm in your wallet…",
  submitted: "Submitted to Base…",
  done: "Done",
  failed: "Try again",
};
