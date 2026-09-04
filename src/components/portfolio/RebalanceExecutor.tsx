"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { parseUnits, type Address } from "viem";
import type { PortfolioSnapshot, RebalanceSuggestion } from "@/domain/portfolio";
import { USDC_DECIMALS, MIN_TRADE_USD } from "@/config/chain";
import { usePortfolioExecution } from "@/hooks/usePortfolioExecution";
import { qk, useAssets } from "@/hooks/queries";
import { buyLegBlockedReason, tradingStatus } from "@/lib/trading-status";
import type { CustomLeg } from "@/lib/execution/portfolio-execution";
import { formatUsd } from "@/lib/format";
import { Button } from "@/components/ui/primitives";
import { InfoBanner } from "@/components/common/display";
import { ExecutionProgress } from "@/components/build/ExecutionProgress";

/**
 * Manual rebalance (spec §26): system proposes → user reviews → user approves each leg.
 * Sells run first so USDC is available for buys; same TradeRouter + B20Guard as single trades.
 */
export function RebalanceExecutor({ snapshot, suggestions, templateName }: { snapshot: PortfolioSnapshot; suggestions: RebalanceSuggestion[]; templateName: string }) {
  const { address } = useAccount();
  const qc = useQueryClient();
  const exec = usePortfolioExecution();
  const { data: assetsData } = useAssets();
  const [confirming, setConfirming] = useState(false);
  /**
   * Why a buy cannot run. A raw supply check used to stand here, which let a rebalance queue a buy
   * for a stock that is issued but has no pool — the leg then failed mid-execution, after the user
   * had already signed the sells — and one for a stock whose pool is smaller than the leg itself.
   */
  const blockedReason = (addr: string, targetUsd: number): string | null => {
    const asset = assetsData?.assets.find((a) => a.canonicalId === addr.toLowerCase());
    if (!asset) return "this stock is not in the verified registry";
    const price = assetsData?.prices[asset.canonicalId];
    return buyLegBlockedReason(tradingStatus(asset, price).status, targetUsd, price?.liquidityUsd);
  };
  const skipped: Array<{ symbol: string; reason: string }> = [];

  useEffect(() => {
    if (exec.execution?.status === "COMPLETE" || exec.execution?.status === "PARTIALLY_FILLED") {
      qc.invalidateQueries({ queryKey: qk.portfolio(address ?? "") });
      qc.invalidateQueries({ queryKey: qk.activity(address ?? "") });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exec.execution?.status]);

  const legs: CustomLeg[] = [];
  for (const s of suggestions) {
    if (s.action === "hold" || s.assetAddress === "USDC") continue;
    const holding = snapshot.holdings.find((h) => h.assetAddress.toLowerCase() === (s.assetAddress as string).toLowerCase());
    const usd = Math.abs(s.deltaUsd);
    if (usd < MIN_TRADE_USD) continue;
    if (s.action === "sell") {
      if (!holding || !holding.priceUsd) continue;
      const raw = BigInt(holding.rawBalance);
      const wanted = parseUnits((usd / holding.priceUsd).toFixed(holding.decimals), holding.decimals);
      legs.push({ side: "sell", assetAddress: holding.assetAddress, symbol: holding.symbol, targetUsd: usd, amount: wanted > raw ? raw : wanted });
    } else {
      const reason = blockedReason(s.assetAddress as string, usd);
      if (reason) {
        skipped.push({ symbol: s.symbol, reason });
        continue;
      }
      legs.push({ side: "buy", assetAddress: s.assetAddress as Address, symbol: s.symbol, targetUsd: usd, amount: parseUnits(usd.toFixed(USDC_DECIMALS), USDC_DECIMALS) });
    }
  }
  const sellsUsd = legs.filter((l) => l.side === "sell").reduce((a, l) => a + l.targetUsd, 0);
  const buysUsd = legs.filter((l) => l.side === "buy").reduce((a, l) => a + l.targetUsd, 0);
  const cashAfterSells = snapshot.usdcValueUsd + sellsUsd;
  const shortfall = Math.max(0, buysUsd - cashAfterSells);

  if (exec.execution && exec.summary) {
    return <ExecutionProgress execution={exec.execution} currentStepId={exec.currentStepId} running={exec.running} summary={exec.summary} onRetry={() => exec.retry()} onClose={() => exec.reset()} verb="trades" />;
  }
  if (legs.length === 0) return null;

  return (
    <div className="px-4 py-3 border-t border-line flex flex-col gap-3">
      {!confirming ? (
        <Button variant="secondary" onClick={() => setConfirming(true)}>
          Rebalance toward {templateName} ({legs.length} {legs.length === 1 ? "trade" : "trades"})
        </Button>
      ) : (
        <>
          <p className="text-[13px] text-ink-secondary">
            {legs.filter((l) => l.side === "sell").length > 0 && `Sell ${formatUsd(sellsUsd)} first, then `}buy {formatUsd(buysUsd)}. Each trade gets a fresh quote and a wallet confirmation.
          </p>
          {skipped.length > 0 && (
            <InfoBanner>
              {`Skipped: ${skipped.map((x) => `${x.symbol} (${x.reason})`).join(", ")}. That share stays as USDC — nothing is bought at a price you did not mean to accept.`}
            </InfoBanner>
          )}
          {shortfall > 0 && <InfoBanner tone="warning">About {formatUsd(shortfall)} of the buys may exceed your USDC after the sells; those legs will fail honestly and can be retried after topping up.</InfoBanner>}
          <div className="flex gap-2">
            <Button variant="secondary" full onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button full onClick={() => exec.startLegs(legs)}>
              Start {legs.length} {legs.length === 1 ? "trade" : "trades"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
