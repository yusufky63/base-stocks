"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { parseUnits, type Address } from "viem";
import type { PortfolioSnapshot } from "@/domain/portfolio";
import { USDC_DECIMALS } from "@/config/chain";
import { usePortfolioExecution } from "@/hooks/usePortfolioExecution";
import { qk } from "@/hooks/queries";
import type { CustomLeg } from "@/lib/execution/portfolio-execution";
import type { DriftRow, DriftSummary } from "@/lib/portfolio/drift";
import { formatUsd } from "@/lib/format";
import { Button } from "@/components/ui/primitives";
import { InfoBanner } from "@/components/common/display";
import { ExecutionProgress } from "@/components/build/ExecutionProgress";

/**
 * Manual rebalance (spec §26): system proposes → user reviews → user approves each leg.
 * Sells run first so USDC is available for buys; same TradeRouter + B20Guard as single trades.
 * The legs come straight from the drift table, so what is shown is exactly what is traded.
 */
export function RebalanceExecutor({ snapshot, rows, summary, targetName }: { snapshot: PortfolioSnapshot; rows: DriftRow[]; summary: DriftSummary; targetName: string }) {
  const { address } = useAccount();
  const qc = useQueryClient();
  const exec = usePortfolioExecution();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (exec.execution?.status === "COMPLETE" || exec.execution?.status === "PARTIALLY_FILLED") {
      qc.invalidateQueries({ queryKey: qk.portfolio(address ?? "") });
      qc.invalidateQueries({ queryKey: qk.activity(address ?? "") });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exec.execution?.status]);

  const legs: CustomLeg[] = [];
  const skipped = rows.filter((r) => r.blocked);
  for (const r of rows) {
    if (r.blocked || (r.action !== "buy" && r.action !== "sell")) continue;
    const usd = Math.abs(r.deltaUsd);
    if (r.action === "sell") {
      const holding = snapshot.holdings.find((h) => h.assetAddress.toLowerCase() === (r.assetAddress as string).toLowerCase());
      if (!holding || !holding.priceUsd) continue;
      const raw = BigInt(holding.rawBalance);
      const wanted = parseUnits((usd / holding.priceUsd).toFixed(holding.decimals), holding.decimals);
      legs.push({ side: "sell", assetAddress: holding.assetAddress, symbol: holding.symbol, targetUsd: usd, amount: wanted > raw ? raw : wanted });
    } else {
      legs.push({ side: "buy", assetAddress: r.assetAddress as Address, symbol: `${r.symbol}c`, targetUsd: usd, amount: parseUnits(usd.toFixed(USDC_DECIMALS), USDC_DECIMALS) });
    }
  }

  if (exec.execution && exec.summary) {
    return (
      <div className="px-4 py-3 border-t border-line">
        <ExecutionProgress execution={exec.execution} currentStepId={exec.currentStepId} running={exec.running} summary={exec.summary} onRetry={() => exec.retry()} onClose={() => exec.reset()} verb="trades" />
      </div>
    );
  }
  if (legs.length === 0) return null;

  const sells = legs.filter((l) => l.side === "sell").length;

  return (
    <div className="px-4 py-3 border-t border-line flex flex-col gap-3">
      {!confirming ? (
        <Button variant="secondary" onClick={() => setConfirming(true)}>
          Rebalance toward {targetName} · {legs.length} {legs.length === 1 ? "trade" : "trades"}
        </Button>
      ) : (
        <>
          <p className="text-[13px] text-ink-secondary">
            {sells > 0 && `Sell ${formatUsd(summary.sellsUsd)} first, then `}buy {formatUsd(summary.buysUsd)}. Each trade gets a fresh quote and a wallet confirmation; nothing runs in the background.
          </p>
          {skipped.length > 0 && (
            <InfoBanner tone="warning">
              {`Left out: ${skipped.map((x) => `${x.symbol} (${x.blocked})`).join(", ")}. That share stays as it is — nothing is bought or sold at a price you did not mean to accept.`}
            </InfoBanner>
          )}
          {summary.shortfallUsd > 0 && <InfoBanner tone="warning">About {formatUsd(summary.shortfallUsd)} of the buys exceeds your USDC even after the sells; those legs will fail honestly and can be retried after topping up.</InfoBanner>}
          <div className="flex gap-2">
            <Button variant="secondary" full onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button full onClick={() => void exec.startLegs(legs)}>
              Start {legs.length} {legs.length === 1 ? "trade" : "trades"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
