"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { formatUsd } from "@/lib/format";
import { PriceChange } from "@/components/common/display";
import { LAUNCHPAD_NAME, launchpadMarketsUrl, launchpadTokenUrl } from "@/content/ecosystem";

type LaunchpadMarket = {
  token: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  priceUsd: number | null;
  fdvUsd: number | null;
  change24hPercent: number | null;
  volume24hUsd: number | null;
  holders: number;
  launchedAt: string;
};

/**
 * Tokens launched on StockPair with this stock as the quote asset. Renders nothing when the
 * launchpad has no markets for the stock (or is unreachable) so the Details tab stays clean.
 */
export function LaunchpadModule({ stockAddress, underlying }: { stockAddress: string; underlying: string }) {
  const { data } = useQuery({
    queryKey: ["launchpad-markets", stockAddress.toLowerCase()],
    queryFn: async (): Promise<LaunchpadMarket[]> => {
      const res = await fetch(`/api/launchpad/markets?stock=${stockAddress}`);
      if (!res.ok) return [];
      const body = (await res.json()) as { markets?: LaunchpadMarket[] };
      return body.markets ?? [];
    },
    staleTime: 60_000,
  });

  const markets = data ?? [];
  if (markets.length === 0) return null;

  return (
    <div className="p-4 border-b border-line">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Launched against {underlying} · {LAUNCHPAD_NAME}</div>
        <a href={launchpadMarketsUrl(stockAddress)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-[12px] text-ink-secondary hover:text-primary transition-fast">
          All markets <ArrowUpRight size={12} strokeWidth={1.75} />
        </a>
      </div>
      <ul className="flex flex-col">
        {markets.map((m) => (
          <li key={m.token}>
            <a href={launchpadTokenUrl(m.token)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 py-2 group">
              {/* Launchpad images come from IPFS gateways; a plain img avoids remote-pattern config. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {m.imageUrl ? <img src={m.imageUrl} alt="" className="h-7 w-7 rounded-full object-cover border border-line" /> : <span aria-hidden className="h-7 w-7 rounded-full border border-line bg-surface inline-flex items-center justify-center font-mono text-[10px] text-ink-muted">{m.symbol.slice(0, 2)}</span>}
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium truncate group-hover:text-primary transition-fast">{m.name}</span>
                <span className="block font-mono text-[11px] text-ink-muted">{m.symbol} · {m.holders} holders</span>
              </span>
              <span className="text-right shrink-0">
                <span className="block num text-[13px]">{m.priceUsd !== null ? formatUsd(m.priceUsd) : "—"}</span>
                <PriceChange value={m.change24hPercent} className="text-[11px]" />
              </span>
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-ink-muted leading-relaxed">Community tokens paired 1:1 with {underlying} on the {LAUNCHPAD_NAME}. Separate product, separate risks.</p>
    </div>
  );
}
