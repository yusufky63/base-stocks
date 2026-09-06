"use client";

import Link from "next/link";
import { useStats } from "@/hooks/queries";
import { formatUsd } from "@/lib/format";
import { Label } from "@/components/ui/primitives";

/**
 * "This stock, on this platform": the stats page's per-stock row, shown where the stock is.
 * Read from the same shared-cached statistics object as everything else, so it costs nothing
 * per visitor; and it is the platform's own figures, not the market's.
 */
export function PlatformActivity({ assetAddress, underlying }: { assetAddress: string; underlying: string }) {
  const { data } = useStats();
  const row = data?.trading.byAsset.find((a) => a.assetAddress.toLowerCase() === assetAddress.toLowerCase());
  const cells = row
    ? [
        { label: "Bought", value: `${row.buys} · ${formatUsd(row.buyUsd)}` },
        { label: "Sold", value: `${row.sells} · ${formatUsd(row.sellUsd)}` },
        { label: "Gifted", value: row.gifted > 0 ? `${row.gifted.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${underlying}` : "—" },
      ]
    : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>{underlying} on BaseStocks</Label>
        <Link href="/stats" className="text-[12px] text-primary font-medium">
          All stats →
        </Link>
      </div>
      {!data ? (
        <p className="text-[13px] text-ink-secondary">Loading…</p>
      ) : !cells ? (
        <p className="text-[13px] text-ink-secondary">No verified trade of {underlying} through the app yet. The first one shows up here once its receipt is in.</p>
      ) : (
        <dl className="grid grid-cols-3 gap-px bg-line border border-line rounded-[6px] overflow-hidden">
          {cells.map((c) => (
            <div key={c.label} className="bg-canvas px-3 py-2 min-w-0">
              <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{c.label}</dt>
              <dd className="font-mono num text-[13px] mt-0.5 truncate">{c.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="text-[11px] text-ink-muted">Trades and gifts of {underlying} made through BaseStocks, each verified against its receipt on Base — not the DEX market as a whole.</p>
    </div>
  );
}
