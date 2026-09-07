"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { ExternalLink } from "lucide-react";
import type { Address } from "viem";
import type { EarnOpportunity } from "@/domain/earn";
import { apiGet, type EarnResponse } from "@/lib/client-api";
import { formatPct, formatUsd, formatUsdCompact, timeAgo } from "@/lib/format";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { USDC_ADDRESS, USDC_DECIMALS } from "@/config/chain";
import { Module, ModuleHeader, Button, Badge, Skeleton } from "@/components/ui/primitives";
import { ProtocolLogo } from "@/components/common/ProtocolLogo";
import { EarnDepositSheet } from "./EarnDepositSheet";
import { qk } from "@/hooks/queries";

interface PositionDTO {
  opportunityId: string;
  provider: EarnOpportunity["provider"];
  title: string;
  underlying: Address;
  underlyingSymbol: string;
  underlyingDecimals: number;
  assets: string;
  valueUsd: number;
  variableApy?: number;
}

const LABEL: Record<EarnOpportunity["provider"], string> = { morpho: "Morpho", aave: "Aave", aerodrome: "Aerodrome", compound: "Compound", uniswap: "Uniswap" };

/**
 * Morpho's own advisory flags, in the words of the person deciding.
 *
 * Only the amber ones reach here — a vault carrying a red flag never leaves the service — so these
 * qualify a venue rather than disqualifying it, which is why they are a badge and not an absence.
 */
const FLAG_COPY: Record<string, { label: string; title: string }> = {
  not_whitelisted: { label: "unvetted", title: "Not on Morpho's curated list — read the vault before depositing" },
  low_liquidity: { label: "thin exit", title: "Much of this vault's deposits are lent out; a full withdrawal may not be immediate" },
};

function vaultFlags(o: EarnOpportunity): Array<{ label: string; title: string }> {
  const warnings = o.metadata.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings
    .filter((w) => (w as { level?: string }).level === "YELLOW")
    .map((w) => {
      const type = String((w as { type?: string }).type ?? "");
      return FLAG_COPY[type] ?? { label: type.replace(/_/g, " "), title: `Morpho flags this vault: ${type.replace(/_/g, " ")}` };
    });
}

/** Total in Earn, value-weighted APY and the yearly figure that implies — all variable, never promised. */
function EarnSummary({ positions }: { positions: PositionDTO[] }) {
  const total = positions.reduce((s, p) => s + p.valueUsd, 0);
  const withApy = positions.filter((p) => p.variableApy !== undefined);
  const weightedBase = withApy.reduce((s, p) => s + p.valueUsd, 0);
  const apy = weightedBase > 0 ? withApy.reduce((s, p) => s + p.valueUsd * (p.variableApy ?? 0), 0) / weightedBase : null;
  return (
    <div className="module-grid grid-cols-3 rounded-none border-0 border-b border-line">
      <div className="p-3">
        <div className="eyebrow">In Earn</div>
        <div className="display num text-[20px]">{formatUsd(total)}</div>
      </div>
      <div className="p-3">
        <div className="eyebrow">Weighted APY</div>
        <div className="display num text-[20px]">{apy !== null ? formatPct(apy, { sign: false }) : "—"}</div>
      </div>
      <div className="p-3">
        <div className="eyebrow">≈ per year</div>
        <div className="display num text-[20px]">{apy !== null ? formatUsd((total * apy) / 100) : "—"}</div>
        <div className="text-[10px] font-mono uppercase text-ink-muted">at today’s variable rate</div>
      </div>
    </div>
  );
}

/** "Put idle USDC to work" + current positions, executed in-app (Morpho ERC-4626, Aave V3, Compound v3). */
export function UsdcEarnModule() {
  const { address } = useAccount();
  const qc = useQueryClient();
  const balances = useTokenBalances(address, USDC_ADDRESS);
  const venues = useQuery({ queryKey: ["earn", "usdc"], queryFn: () => apiGet<EarnResponse>("/api/earn/usdc"), staleTime: 2 * 60_000 });
  const positions = useQuery({ queryKey: ["earn", "positions", address ?? ""], queryFn: () => apiGet<{ positions: PositionDTO[] }>(`/api/earn/positions?user=${address}`), enabled: !!address, staleTime: 30_000 });
  const [sheet, setSheet] = useState<{ o: EarnOpportunity; action: "deposit" | "withdraw"; available: bigint } | null>(null);

  // Every venue the service curated. Ones without an in-app deposit path link out instead of
  // being hidden: knowing a better rate exists is worth more than a uniform row of buttons.
  const list = venues.data?.opportunities ?? [];
  const pos = positions.data?.positions ?? [];
  const refresh = () => {
    balances.refetch();
    qc.invalidateQueries({ queryKey: ["earn", "positions", address ?? ""] });
    qc.invalidateQueries({ queryKey: qk.portfolio(address ?? "") });
  };

  return (
    <Module>
      <ModuleHeader index="E" title="Idle USDC · earn" action={venues.data ? <span className="font-mono text-[11px] text-ink-muted">discovered {timeAgo(venues.data.updatedAt)}</span> : undefined} />
      {pos.length > 0 && (
        <div className="border-b border-line">
          <EarnSummary positions={pos} />
          <div className="px-4 pt-3 eyebrow">Your positions</div>
          {pos.map((p) => {
            const o = list.find((x) => x.id === p.opportunityId);
            return (
              <div key={p.opportunityId} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="font-medium text-[14px] truncate">{p.title}</div>
                  <div className="text-[12px] text-ink-secondary">
                    {LABEL[p.provider]}
                    {p.variableApy !== undefined ? ` · ${formatPct(p.variableApy, { sign: false })} variable` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="display num text-[16px]">{formatUsd(p.valueUsd)}</span>
                  {o && (
                    <Button size="sm" variant="secondary" onClick={() => setSheet({ o, action: "withdraw", available: BigInt(p.assets) })}>
                      Withdraw
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {venues.isLoading && (
        <div className="p-4 flex flex-col gap-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      )}
      {!venues.isLoading && list.length === 0 && <p className="px-4 py-4 text-[13px] text-ink-secondary">No USDC yield venue is available right now.</p>}
      {list.map((o) => (
        <div key={o.id} className="flex items-center justify-between gap-3 px-4 py-3 border-b border-line last:border-b-0">
          <div className="min-w-0">
            <div className="font-medium text-[14px] truncate">{o.title}</div>
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-secondary">
              <ProtocolLogo provider={o.provider} size={16} withLabel label={o.provider === "morpho" ? "Powered by Morpho" : LABEL[o.provider]} className="font-medium text-ink whitespace-nowrap" />
              <span>{o.tvlUsd !== undefined ? `${formatUsdCompact(o.tvlUsd)} TVL` : o.type}</span>
              {vaultFlags(o).map((f) => (
                <span key={f.label} title={f.title}>
                  <Badge tone="warning" className="h-5 px-1.5 text-[10px]">
                    {f.label}
                  </Badge>
                </span>
              ))}
              {o.url && (
                <a href={o.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-ink-muted hover:text-ink">
                  venue <ExternalLink size={11} strokeWidth={1.75} />
                </a>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <div className="text-right">
              <div className="display num text-[16px]">{o.variableApy !== undefined ? formatPct(o.variableApy, { sign: false }) : "—"}</div>
              <div className="text-[10px] font-mono uppercase text-ink-muted">
                {o.rewardsApr !== undefined ? `+ ${formatPct(o.rewardsApr, { sign: false })} rewards · ` : ""}
                {typeof o.metadata.performanceFee === "number" && o.metadata.performanceFee > 0 ? `${Math.round(o.metadata.performanceFee * 100)}% fee · ` : ""}variable · {timeAgo(o.dataTimestamp)}
              </div>
            </div>
            {o.inApp ? (
              <Button size="sm" disabled={!address || balances.usdc === 0n} onClick={() => setSheet({ o, action: "deposit", available: balances.usdc })}>
                Deposit
              </Button>
            ) : (
              <a
                href={o.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-[6px] border border-line text-[13px] font-medium text-ink-secondary hover:text-ink hover:border-line-strong transition-fast"
              >
                Open <ExternalLink size={12} strokeWidth={1.75} />
              </a>
            )}
          </div>
        </div>
      ))}
      <p className="px-4 py-3 text-[12px] text-ink-muted border-t border-line">
        Wallet USDC: {address ? formatUsd(Number(balances.usdc) / 10 ** USDC_DECIMALS) : "—"}. Variable rates, never guaranteed. Positions stay in your wallet at the venue.
      </p>
      {sheet && <EarnDepositSheet open onClose={() => setSheet(null)} opportunity={sheet.o} action={sheet.action} available={sheet.available} onDone={refresh} />}
    </Module>
  );
}
