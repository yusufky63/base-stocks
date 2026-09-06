"use client";

import { formatUnits } from "viem";
import { ExternalLink } from "lucide-react";
import type { B20AssetDTO } from "@/domain/asset";
import type { PriceView } from "@/domain/market";
import { KeyValue, Badge } from "@/components/ui/primitives";
import { AddressLabel } from "@/components/common/display";
import { formatUsd, formatTokenAmount } from "@/lib/format";
import { Collapsible } from "@/components/ui/Collapsible";
import { TimeAgo } from "@/components/common/TimeAgo";

/** Deterministic (SSR-safe) timestamp: locale formatting would differ between server and browser. */
const utcStamp = (unixSeconds: number) => `${new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;


/** CoinGecko lists only the liquid tokenized stocks; slugs follow {company}-coinbase-tokenized-stock (verified 2026-09-03). */
const COINGECKO_SLUGS: Record<string, string> = {
  AAPL: "apple-coinbase-tokenized-stock",
  GOOGL: "alphabet-coinbase-tokenized-stock",
  META: "meta-coinbase-tokenized-stock",
  NVDA: "nvidia-coinbase-tokenized-stock",
};

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
        {multiplier !== 1 && <Badge tone="warning">Multiplier {multiplier.toFixed(4)}×</Badge>}
        {pending && <Badge tone="warning">Multiplier change scheduled</Badge>}
      </div>

      <KeyValue k="Contract" v={<AddressLabel address={asset.address} explorer />} />
      <KeyValue
        k="Market data"
        v={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            {[
              ["DexScreener", `https://dexscreener.com/base/${asset.address}`],
              ["GeckoTerminal", `https://www.geckoterminal.com/base/tokens/${asset.address}`],
              ...(COINGECKO_SLUGS[asset.underlying] ? [["CoinGecko", `https://www.coingecko.com/en/coins/${COINGECKO_SLUGS[asset.underlying]}`] as const] : []),
            ].map(([label, url]) => (
              <a key={label} href={url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary font-medium hover:underline">
                {label} <ExternalLink size={11} strokeWidth={1.75} />
              </a>
            ))}
          </span>
        }
      />
      <KeyValue k="Symbol / decimals" v={`${asset.symbol} · ${asset.decimals}`} />
      <KeyValue k="Underlying" v={asset.underlying} />
      {asset.isin && <KeyValue k="ISIN" v={asset.isin} />}
      <KeyValue k="Onchain supply" v={notIssued ? "0 · the issuer has not minted this stock on Base yet" : `${formatTokenAmount(asset.totalSupply, asset.decimals)} tokens`} />
      <KeyValue k="Multiplier (WAD)" v={`${multiplier.toFixed(6)} × (1 token = ${multiplier.toFixed(4)} share-equivalents)`} />
      {pending && <KeyValue k="Scheduled multiplier" v={`${Number(formatUnits(BigInt(pending.multiplier), 18)).toFixed(6)} × effective ${utcStamp(pending.effectiveAt)}`} />}
      <KeyValue k="Transfers" v={asset.transferPaused ? "Paused by issuer" : "Active"} />
      <KeyValue k="Transfer policy ids" v={`sender ${asset.transferSenderPolicyId} · receiver ${asset.transferReceiverPolicyId}`} />

      <Collapsible title="Price source" defaultOpen>
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
        {oracle && <KeyValue k="Issuer price feed" v={<AddressLabel address={oracle.feed} explorer />} />}
        <p className="text-[12px] text-ink-muted pt-2">You trade at the pool price. The issuer&apos;s own price feed is not shown here; it appears in the Markets table&apos;s Reference column and is used only to warn when a pool strays far from the stock.</p>
      </Collapsible>
    </div>
  );
}
