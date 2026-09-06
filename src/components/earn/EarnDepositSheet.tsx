"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { erc20Abi, formatUnits, type Address, type Hash, type Hex } from "viem";
import { base } from "viem/chains";
import type { EarnOpportunity } from "@/domain/earn";
import { apiPost, ApiError } from "@/lib/client-api";
import { attributionCapabilities, withAttribution } from "@/lib/attribution";
import { waitForConfirmation } from "@/lib/trade/execute";
import { humanizeError, TRADE_ERROR_COPY, type HumanError } from "@/lib/errors";
import { parseAmountSafe } from "@/lib/b20/math";
import { formatUsd, formatPct } from "@/lib/format";
import { BASE_CHAIN_ID, USDC_DECIMALS } from "@/config/chain";
import { Sheet } from "@/components/ui/Sheet";
import { AmountInput } from "@/components/ui/Input";
import { Button, Badge, Chip, KeyValue } from "@/components/ui/primitives";
import { ErrorBanner, InfoBanner, TxLink } from "@/components/common/display";

interface PreparedCall {
  kind: "approve" | "deposit" | "withdraw";
  to: Address;
  data: Hex;
  value: string;
}
interface Prepared {
  calls: PreparedCall[];
  description: string;
  spender?: Address;
  underlying: Address;
  underlyingDecimals: number;
}

const PROVIDER_LABEL: Record<EarnOpportunity["provider"], string> = { morpho: "Morpho", aave: "Aave", aerodrome: "Aerodrome", compound: "Compound", uniswap: "Uniswap" };

interface Props {
  open: boolean;
  onClose: () => void;
  opportunity: EarnOpportunity;
  action: "deposit" | "withdraw";
  /** Available underlying balance (wallet USDC for deposits, position size for withdrawals). */
  available: bigint;
  onDone?: () => void;
}

/**
 * In-app Earn execution: server builds the calls (approve + deposit / withdraw), the wallet signs.
 * Same rules as trading: exact approvals to the venue only, simulation first, atomic batch when
 * the wallet supports it, protocol name and risks always visible.
 */
export function EarnDepositSheet({ open, onClose, opportunity, action, available, onDone }: Props) {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });
  const [amount, setAmount] = useState("");
  const [max, setMax] = useState(false);
  const [state, setState] = useState<"idle" | "preparing" | "wallet" | "submitted" | "confirmed" | "failed">("idle");
  const [error, setError] = useState<HumanError | null>(null);
  const [txHash, setTxHash] = useState<Hash | undefined>();
  const decimals = USDC_DECIMALS;
  const parsed = max ? available : parseAmountSafe(amount, decimals);
  const busy = state === "preparing" || state === "wallet" || state === "submitted";
  // Morpho's integrator UX requirements: "Powered by Morpho" attribution and a one-time disclaimer acknowledgment before the first interaction.
  const needsMorphoAck = opportunity.provider === "morpho";
  const [morphoAck, setMorphoAck] = useState<boolean>(() => {
    try {
      return typeof window !== "undefined" && localStorage.getItem("bstocks:morpho-ack") === "1";
    } catch {
      return false;
    }
  });
  const acknowledgeMorpho = (v: boolean) => {
    setMorphoAck(v);
    try {
      if (v) localStorage.setItem("bstocks:morpho-ack", "1");
      else localStorage.removeItem("bstocks:morpho-ack");
    } catch {
      /* ignore */
    }
  };

  const run = async () => {
    if (!address || !walletClient || !publicClient) return;
    if (chainId !== BASE_CHAIN_ID) {
      setError({ code: "WRONG_NETWORK", message: TRADE_ERROR_COPY.WRONG_NETWORK });
      return;
    }
    if (parsed <= 0n) return;
    setError(null);
    setState("preparing");
    try {
      const prepared = await apiPost<Prepared>("/api/earn/prepare", { opportunityId: opportunity.id, user: address, amount: max && action === "withdraw" ? "max" : parsed.toString(), action });
      let calls = prepared.calls;
      if (action === "deposit" && prepared.spender) {
        const allowance = await publicClient.readContract({ address: prepared.underlying, abi: erc20Abi, functionName: "allowance", args: [address, prepared.spender] });
        if (allowance >= parsed) calls = calls.filter((c) => c.kind !== "approve");
      }
      // Simulate the main call when no approval is pending (otherwise the wallet batches it).
      const main = calls.find((c) => c.kind !== "approve")!;
      if (!calls.some((c) => c.kind === "approve")) {
        await publicClient.call({ account: address, to: main.to, data: main.data, value: BigInt(main.value) });
      }
      let atomic = false;
      try {
        const caps = (await walletClient.getCapabilities({ account: address, chainId: BASE_CHAIN_ID })) as { atomic?: { status?: string } };
        atomic = caps.atomic?.status === "supported" || caps.atomic?.status === "ready";
      } catch {
        atomic = false;
      }
      setState("wallet");
      let hash: Hash | undefined;
      if (calls.length > 1 && atomic) {
        const { id } = await walletClient.sendCalls({ account: address, chain: base, forceAtomic: true, calls: calls.map((c) => ({ to: c.to, data: withAttribution(c.data), value: BigInt(c.value) })), capabilities: { ...attributionCapabilities() } });
        setState("submitted");
        const result = await walletClient.waitForCallsStatus({ id, timeout: 180_000 });
        if (result.status === "failure") throw new Error("Batched transaction failed");
        hash = result.receipts?.[result.receipts.length - 1]?.transactionHash;
      } else {
        for (const c of calls) {
          hash = await walletClient.sendTransaction({ account: address, chain: base, to: c.to, data: withAttribution(c.data), value: BigInt(c.value) });
          setState("submitted");
          setTxHash(hash);
          const status = await waitForConfirmation(hash);
          if (status === "failed") throw new Error("Transaction reverted onchain");
        }
      }
      if (hash) setTxHash(hash);
      // Activity record (never proof: the activity service verifies it against the receipt).
      if (hash) {
        const amount = max && action === "withdraw" ? available : parsed;
        void apiPost("/api/earn/record", {
          id: `earn_${hash.slice(2, 18)}`,
          owner: address,
          opportunityId: opportunity.id,
          provider: opportunity.provider,
          action,
          amount: amount.toString(),
          usdValue: Number(formatUnits(amount, decimals)),
          txHash: hash,
        }).catch(() => undefined);
      }
      setState("confirmed");
      onDone?.();
    } catch (err) {
      setError(err instanceof ApiError ? { code: (err.code in TRADE_ERROR_COPY ? err.code : "UNKNOWN") as HumanError["code"], message: err.message } : humanizeError(err));
      setState("failed");
    }
  };

  const title = action === "deposit" ? `Deposit · ${PROVIDER_LABEL[opportunity.provider]}` : `Withdraw · ${PROVIDER_LABEL[opportunity.provider]}`;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      locked={busy}
      footer={
        state === "confirmed" ? (
          <Button full onClick={onClose}>
            Done
          </Button>
        ) : (
          <Button full size="lg" loading={busy} disabled={parsed <= 0n || parsed > available || (needsMorphoAck && !morphoAck)} onClick={run}>
            {state === "failed" ? "Try again" : action === "deposit" ? `Deposit ${parsed > 0n ? formatUsd(Number(formatUnits(parsed, decimals))) : ""}` : `Withdraw ${max ? "everything" : parsed > 0n ? formatUsd(Number(formatUnits(parsed, decimals))) : ""}`}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge tone="primary">{PROVIDER_LABEL[opportunity.provider]}</Badge>
          <Badge>{opportunity.type}</Badge>
          <Badge tone={opportunity.riskLabel === "higher" ? "danger" : "warning"}>risk {opportunity.riskLabel}</Badge>
          {opportunity.variableApy !== undefined && <Badge tone="positive">{formatPct(opportunity.variableApy, { sign: false })} variable</Badge>}
        </div>
        <div className="font-medium">{opportunity.title}</div>
        <AmountInput value={max ? formatUnits(available, decimals) : amount} onChange={(v) => { setMax(false); setAmount(v); }} unit="USDC" ariaLabel={`${action} amount in USDC`} />
        {action === "deposit" && opportunity.variableApy !== undefined && parsed > 0n && (
          <p className="text-[12px] text-ink-muted num -mt-2">{`≈ ${formatUsd(Number(formatUnits(parsed, decimals)) * opportunity.variableApy)} per year at the current variable rate — it moves with the market.`}</p>
        )}
        <div className="flex gap-2">
          {[25, 50, 100].map((p) => (
            <Chip key={p} active={p === 100 ? max : false} onClick={() => { if (p === 100) setMax(true); else { setMax(false); setAmount(formatUnits((available * BigInt(p)) / 100n, decimals)); } }} disabled={available === 0n}>
              {p === 100 ? "Max" : `${p}%`}
            </Chip>
          ))}
        </div>
        <KeyValue k={action === "deposit" ? "Available USDC" : "Position"} v={formatUsd(Number(formatUnits(available, decimals)))} />
        <KeyValue k="Network" v="Base" />
        {needsMorphoAck && (
          <div className="border border-line rounded-[6px] p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">Powered by Morpho</span>
              <a href="https://morpho.org/disclaimers/" target="_blank" rel="noreferrer noopener" className="text-[12px] text-primary font-medium">
                Morpho disclaimer
              </a>
            </div>
            <label className="flex items-start gap-2 text-[12px] text-ink-secondary cursor-pointer">
              <input type="checkbox" checked={morphoAck} onChange={(e) => acknowledgeMorpho(e.target.checked)} className="mt-0.5 accent-[var(--primary)]" />
              <span>Accessing the Morpho Protocol through this app is governed by BaseStocks’ terms and Morpho’s Disclaimer. Morpho is an immutable, permissionless, non-custodial protocol; BaseStocks is only the interface.</span>
            </label>
          </div>
        )}
        <ul className="list-disc pl-4 text-[13px] text-ink-secondary flex flex-col gap-1">
          {opportunity.risks.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {state === "wallet" && <InfoBanner tone="info">Confirm in your wallet. {action === "deposit" ? "An exact approval for the venue is included." : ""}</InfoBanner>}
        {state === "submitted" && <InfoBanner tone="info">Submitted to Base…</InfoBanner>}
        {state === "confirmed" && (
          <InfoBanner tone="positive">
            Confirmed. {txHash && <TxLink hash={txHash} />}
          </InfoBanner>
        )}
        {error && <ErrorBanner message={error.message} detail={error.detail} />}
        <p className="text-[12px] text-ink-muted">Estimated returns are variable and never guaranteed. BaseStocks never custodies funds; the position lives in your wallet at {PROVIDER_LABEL[opportunity.provider]}.</p>
      </div>
    </Sheet>
  );
}
