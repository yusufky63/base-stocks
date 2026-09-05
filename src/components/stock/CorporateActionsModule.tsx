"use client";

import type { B20AssetDTO } from "@/domain/asset";
import { useAnnouncements } from "@/hooks/queries";
import { Badge, Label } from "@/components/ui/primitives";
import { Collapsible } from "@/components/ui/Collapsible";
import { TxLink } from "@/components/common/display";
import { timeAgo } from "@/lib/format";

/**
 * "Corporate action scheduled → Details" (spec §8.5). Plain language first; raw event data
 * stays behind the expandable details. Renders nothing when there is nothing to say.
 */
export function CorporateActionsModule({ asset }: { asset: B20AssetDTO }) {
  const { data } = useAnnouncements(asset.address);
  const events = data?.events ?? [];
  const oraclePaused = asset.oracle?.paused ?? false;
  const multiplier = Number(asset.multiplier) / 1e18;
  const pending = asset.pendingMultiplier;
  if (!oraclePaused && events.length === 0 && multiplier === 1 && !pending) return null;

  return (
    <div className="border border-line rounded-[8px] bg-canvas p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Label>Corporate actions</Label>
        {oraclePaused ? <Badge tone="danger">In progress</Badge> : pending ? <Badge tone="warning">Scheduled</Badge> : null}
      </div>
      {oraclePaused && <p className="text-[14px]">A corporate action is in progress. The reference price is frozen until the issuer updates the multiplier and price; onchain trading and transfers continue unless paused.</p>}
      <p className="text-[13px] text-ink-secondary">
        What this means for you: your raw token balance never changes. A split or dividend changes the multiplier, so the number of share-equivalents each token stands for changes with it, while the reference feed is total-return — it publishes price × multiplier — so one token is worth the same the day after as the day before. Your cost basis and profit or loss are kept in raw units and do not move either.
      </p>
      {pending && (
        <p className="text-[14px]">
          The issuer has scheduled a multiplier change to {(Number(pending.multiplier) / 1e18).toFixed(4)}× effective {new Date(pending.effectiveAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC (ERC-8056 advance notice). Your token balance will not change; the number of share-equivalents each token represents will.
        </p>
      )}
      {multiplier !== 1 && (
        <p className="text-[14px] text-ink-secondary">
          Current multiplier is {multiplier.toFixed(4)}×: one token equals {multiplier.toFixed(4)} share-equivalents after past dividends or splits.
        </p>
      )}
      {events.length > 0 && (
        <Collapsible title={`${events.length} event${events.length === 1 ? "" : "s"} · details`}>
          <ul className="flex flex-col gap-2 text-[13px]">
            {events.slice(0, 20).map((e, i) => (
              <li key={`${e.txHash}-${i}`} className="border border-line rounded-[6px] px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {e.kind === "announcement"
                      ? `Announcement${e.id ? ` · ${e.id}` : ""}`
                      : e.kind === "end-announcement"
                        ? `Announcement ended${e.id ? ` · ${e.id}` : ""}`
                        : e.kind === "multiplier-cancelled"
                          ? `Scheduled multiplier ${Number(e.multiplier).toFixed(4)}× cancelled`
                          : e.kind === "metadata"
                            ? `Metadata updated · ${e.id}${e.description ? ` = ${e.description}` : " (removed)"}`
                            : `Multiplier updated → ${Number(e.multiplier).toFixed(4)}×`}
                  </span>
                  <span className="font-mono text-[11px] text-ink-muted">{e.timestamp ? timeAgo(e.timestamp) : `block ${e.blockNumber}`}</span>
                </div>
                {e.description && <p className="text-ink-secondary mt-1">{e.description}</p>}
                <div className="mt-1 flex gap-3">
                  {e.uri && (
                    <a href={e.uri} target="_blank" rel="noreferrer" className="text-primary text-[12px] font-medium">
                      Issuer document
                    </a>
                  )}
                  <TxLink hash={e.txHash}>tx</TxLink>
                </div>
              </li>
            ))}
          </ul>
        </Collapsible>
      )}
      {data && <p className="text-[11px] font-mono text-ink-muted">Scanned from block {data.scannedFromBlock.toLocaleString()}</p>}
    </div>
  );
}
