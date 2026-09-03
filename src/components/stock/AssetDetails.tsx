"use client";

import { formatUnits } from "viem";
import type { B20AssetDTO } from "@/domain/asset";
import type { PriceView } from "@/domain/market";
import { KeyValue, Badge } from "@/components/ui/primitives";
import { AddressLabel } from "@/components/common/display";
import { formatUsd, formatPct, formatTokenAmount } from "@/lib/format";
import { Collapsible } from "@/components/ui/Collapsible";
import { TimeAgo } from "@/components/common/TimeAgo";

/** Deterministic (SSR-safe) timestamp: locale formatting would differ between server and browser. */
const utcStamp = (unixSeconds: number) => `${new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

const FRESHNESS_LABEL = { live: "live", "last-close": "last close · market closed", stale: "stale", frozen: "frozen · corporate action" } as const;

/** Asset details / B20 / Oracle / Contract — advanced, collapsed by default on mobile. */
export function AssetDetails({ asset, price }: { asset: B20AssetDTO; price: PriceView | null }) {
  const oracle = asset.oracle;
  const multiplier = Number(formatUnits(BigInt(asset.multiplier), 18));
  const notIssued = BigInt(asset.totalSupply ?? "0") === 0n;
  const pending = asset.pendingMultiplier;
  const freshness = oracle?.freshness ?? "stale";
  return (
    <div className="p-4 flex flex-col gap-2">
      <div className="flex flex-wrap gap-2 mb-1">
        <Badge tone={asset.status === "active" ? "positive" : asset.status === "paused" ? "danger" : "neutral"}>{asset.status}</Badge>
        <Badge tone="primary">B20 · Coinbase Tokenized Stock</Badge>
        {notIssued && <Badge tone="warning">Not issued onchain yet</Badge>}
        {freshness === "frozen" && <Badge tone="danger">Corporate action · feed frozen</Badge>}
        {freshness === "stale" && <Badge tone="warning">Reference stale</Badge>}
        {freshness === "last-close" && <Badge>Reference · last close</Badge>}
        {multiplier !== 1 && <Badge tone="warning">Multiplier {multiplier.toFixed(4)}×</Badge>}
        {pending && <Badge tone="warning">Multiplier change scheduled</Badge>}
      </div>

      <KeyValue k="Contract" v={<AddressLabel address={asset.address} explorer />} />
      <KeyValue k="Symbol / decimals" v={`${asset.symbol} · ${asset.decimals}`} />
      <KeyValue k="Underlying" v={asset.underlying} />
      {asset.isin && <KeyValue k="ISIN" v={asset.isin} />}
      <KeyValue k="Onchain supply" v={notIssued ? "0 · the issuer has not minted this stock on Base yet" : `${formatTokenAmount(asset.totalSupply, asset.decimals)} tokens`} />
      <KeyValue k="Multiplier (WAD)" v={`${multiplier.toFixed(6)} × (1 token = ${multiplier.toFixed(4)} share-equivalents)`} />
      {pending && <KeyValue k="Scheduled multiplier" v={`${Number(formatUnits(BigInt(pending.multiplier), 18)).toFixed(6)} × effective ${utcStamp(pending.effectiveAt)}`} />}
      <KeyValue k="Transfers" v={asset.transferPaused ? "Paused by issuer" : "Active"} />
      <KeyValue k="Transfer policy ids" v={`sender ${asset.transferSenderPolicyId} · receiver ${asset.transferReceiverPolicyId}`} />

      <Collapsible title="Price sources" defaultOpen>
        <KeyValue
          k="Market (DEX)"
          v={
            price?.marketUsd !== null && price?.marketUsd !== undefined ? (
              <>
                {formatUsd(price.marketUsd, { precise: true })} · <TimeAgo value={price.marketUpdatedAt} />
              </>
            ) : notIssued ? (
              "No pool yet"
            ) : (
              "Unavailable"
            )
          }
        />
        <KeyValue
          k="Reference (Chainlink)"
          v={
            oracle ? (
              <>
                {formatUsd(oracle.priceUsd, { precise: true })} · <TimeAgo value={oracle.updatedAt} /> · {FRESHNESS_LABEL[freshness]}
              </>
            ) : (
              "Unavailable"
            )
          }
        />
        <KeyValue k="Market vs reference" v={price?.deviationPct !== null && price?.deviationPct !== undefined ? formatPct(price.deviationPct, { sign: true }) : "—"} />
        {oracle && <KeyValue k="Feed" v={<AddressLabel address={oracle.feed} explorer />} />}
        {oracle && <KeyValue k="Stale after" v={`${(oracle.staleAfterSeconds / 3600).toFixed(0)} h (feed heartbeat is 24 h; it also updates on a 0.5% move during US market hours)`} />}
        <p className="text-[12px] text-ink-muted pt-2">The reference feed reports a total-return price per token (multiplier already applied), updates during US market hours and holds its last close off-hours. It freezes during corporate actions and is never used as an executable price.</p>
      </Collapsible>
    </div>
  );
}
