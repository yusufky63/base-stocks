"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, ExternalLink } from "lucide-react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import type { EarnOpportunity } from "@/domain/earn";
import { USDC_ADDRESS } from "@/config/chain";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { Badge, Button, cx } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/Sheet";
import { formatPct, formatUsdCompact } from "@/lib/format";
import { EarnDepositSheet } from "./EarnDepositSheet";
import { ProtocolLogo } from "@/components/common/ProtocolLogo";

export const PROVIDER_LABEL: Record<EarnOpportunity["provider"], string> = { morpho: "Morpho", aave: "Aave", aerodrome: "Aerodrome", compound: "Compound", uniswap: "Uniswap" };
export const TYPE_LABEL: Record<EarnOpportunity["type"], string> = { supply: "Supply", vault: "Vault", liquidity: "Liquidity", borrow: "Borrow" };

interface Props {
  /** null closes the sheet. */
  o: EarnOpportunity | null;
  /** Underlying ticker of the stock the venue is for (e.g. NVDA). */
  symbol: string;
  onClose: () => void;
  /** Earn page: offer a link to the stock page from inside the sheet. */
  showStockLink?: boolean;
}

/**
 * One venue, explained before any action: rate, size, risks, then either an in-app deposit
 * (Morpho vaults, Aave, Compound) or a hand-off to the venue's own interface. Shared by the
 * stock page tab and the Earn page, so a venue means the same thing everywhere.
 */
export function VenueSheet({ o, symbol, onClose, showStockLink = false }: Props) {
  const { address } = useAccount();
  const balances = useTokenBalances(address, (o?.assetAddress ?? USDC_ADDRESS) as Address);
  const [deposit, setDeposit] = useState(false);
  return (
    <>
      <Sheet open={!!o && !deposit} onClose={onClose} title={o ? `${PROVIDER_LABEL[o.provider]} · ${TYPE_LABEL[o.type]}` : ""}>
        {o && <VenueDetail o={o} symbol={symbol} connected={!!address} onDeposit={() => setDeposit(true)} showStockLink={showStockLink} />}
      </Sheet>
      {o && deposit && (
        <EarnDepositSheet
          open
          onClose={() => {
            setDeposit(false);
            onClose();
          }}
          opportunity={o}
          action="deposit"
          available={balances.raw}
          onDone={() => balances.refetch()}
        />
      )}
    </>
  );
}

function VenueDetail({ o, symbol, connected, onDeposit, showStockLink }: { o: EarnOpportunity; symbol: string; connected: boolean; onDeposit: () => void; showStockLink: boolean }) {
  const venue = PROVIDER_LABEL[o.provider];
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="font-medium text-[16px]">{o.title}</div>
        <div className="flex gap-2 mt-2 flex-wrap">
          <ProtocolLogo provider={o.provider} size={18} withLabel className="text-[13px] font-medium" />
          <Badge>{TYPE_LABEL[o.type]}</Badge>
          <Badge tone={o.riskLabel === "higher" ? "danger" : o.riskLabel === "medium" ? "warning" : "neutral"}>risk: {o.riskLabel}</Badge>
          {o.inApp ? <Badge tone="positive">in-app</Badge> : <Badge>on venue</Badge>}
        </div>
      </div>
      <div className="module-grid grid-cols-2">
        <div className="p-3">
          <div className="text-[11px] font-mono uppercase text-ink-muted">{o.type === "borrow" ? "Borrow rate (APY)" : "Estimated APY"}</div>
          <div className="display num text-[22px]">{o.variableApy !== undefined ? formatPct(o.variableApy, { sign: false }) : "—"}</div>
          <div className="text-[11px] text-ink-muted">as of {new Date(o.dataTimestamp).toISOString().replace("T", " ").slice(0, 16)} UTC</div>
        </div>
        <div className="p-3">
          <div className="text-[11px] font-mono uppercase text-ink-muted">{o.tvlUsd !== undefined ? "TVL" : "Liquidity"}</div>
          <div className="display num text-[22px]">{formatUsdCompact(o.tvlUsd ?? o.liquidityUsd ?? null)}</div>
          <div className="text-[11px] text-ink-muted">source: {venue}</div>
        </div>
      </div>
      <div>
        <div className="text-[11px] font-mono uppercase text-ink-muted mb-1">Risks to understand</div>
        <ul className="list-disc pl-4 text-[13px] text-ink-secondary flex flex-col gap-1">
          {o.risks.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
      {o.inApp ? (
        <>
          <Button size="lg" full onClick={onDeposit} disabled={!connected}>
            Deposit {symbol} from here <ArrowUpRight size={16} strokeWidth={1.75} />
          </Button>
          <p className="text-[12px] text-ink-muted">Exact approval to {venue} only, simulated first, signed by your wallet. Positions and withdrawals live on the Earn page.</p>
        </>
      ) : (
        <>
          {o.url && (
            <a href={o.url} target="_blank" rel="noreferrer noopener" className={cx("inline-flex items-center justify-center gap-2 h-12 rounded-[6px] bg-primary text-primary-contrast font-medium")}>
              Open on {venue} <ExternalLink size={16} strokeWidth={1.75} />
            </a>
          )}
          <p className="text-[12px] text-ink-muted">
            {o.type === "liquidity"
              ? `Adding or removing liquidity happens in ${venue}'s interface for now; the position, its range and uncollected fees are tracked here under Liquidity positions once it exists.`
              : o.type === "borrow"
                ? `Supplying ${symbol} as collateral and borrowing happen in ${venue}'s interface; loan health is your responsibility and liquidation is possible.`
                : `You will complete the deposit in ${venue}'s own interface with your wallet.`}{" "}
            BStocks never custodies funds.
          </p>
        </>
      )}
      {showStockLink && (
        <Link href={`/stocks/${o.assetAddress}`} className="text-[13px] text-primary font-medium">
          View {symbol} → price, position and trading
        </Link>
      )}
    </div>
  );
}
