"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, Link2 } from "lucide-react";
import type { Address } from "viem";
import type { GiftRecord } from "@/domain/gift";
import { apiGet } from "@/lib/client-api";
import { useAssets, useBasename } from "@/hooks/queries";
import { formatTokenAmount, shortenAddress } from "@/lib/format";
import { AssetLogo } from "@/components/common/display";
import { TimeAgo } from "@/components/common/TimeAgo";
import { Badge, ModuleHeader, Skeleton } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/Segmented";

const ZERO = "0x0000000000000000000000000000000000000000";

function statusInfo(g: GiftRecord): { label: string; tone: "positive" | "warning" | "danger" | "neutral" | "primary" } {
  if (g.status === "claimed") return { label: "Claimed", tone: "positive" };
  if (g.status === "reclaimed") return { label: "Cancelled", tone: "neutral" };
  if (g.status === "failed") return { label: "Failed", tone: "danger" };
  if (g.kind === "claim-link") {
    if (g.expiresAt !== undefined && Date.now() > g.expiresAt) return { label: "Expired", tone: "neutral" };
    return { label: "Awaiting claim", tone: "primary" };
  }
  if (g.status === "confirmed") return { label: "Delivered", tone: "positive" };
  return { label: "Submitted", tone: "warning" };
}

function CounterpartyName({ address }: { address: Address }) {
  const { data } = useBasename(address);
  return <>{data?.name ?? shortenAddress(address)}</>;
}

/** Everything sent and received: direct sends, purchases for others and claim links with live states. */
export function GiftHistory({ owner }: { owner: Address }) {
  const [filter, setFilter] = useState<"all" | "sent" | "received">("all");
  const assets = useAssets();
  const gifts = useQuery({
    queryKey: ["gifts", owner.toLowerCase()],
    queryFn: () => apiGet<{ gifts: GiftRecord[] }>(`/api/gifts?owner=${owner}`).then((r) => r.gifts),
    refetchInterval: 30_000,
  });

  const me = owner.toLowerCase();
  const list = (gifts.data ?? []).filter((g) => {
    if (!g.txHash) return false; // drafts never left the wallet
    const sent = g.sender.toLowerCase() === me;
    if (filter === "sent") return sent;
    if (filter === "received") return !sent;
    return true;
  });

  return (
    <section>
      <ModuleHeader
        title="Gift history"
        action={
          <Segmented<"all" | "sent" | "received">
            size="sm"
            className="w-[240px]"
            ariaLabel="Filter gifts"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "sent", label: "Sent" },
              { value: "received", label: "Received" },
            ]}
          />
        }
      />
      {gifts.isLoading ? (
        <div className="p-4 flex flex-col gap-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : list.length === 0 ? (
        <p className="px-4 py-6 text-[14px] text-ink-secondary">
          {filter === "received" ? "No gifts received yet." : "Nothing here yet. Send stock to a Basename, or create a claim link for someone without a wallet."}
        </p>
      ) : (
        <ul>
          {list.map((g) => {
            const sent = g.sender.toLowerCase() === me;
            const asset = assets.data?.assets.find((a) => a.canonicalId === g.assetAddress.toLowerCase());
            const decimals = asset?.decimals ?? 8;
            const scaled = asset ? (BigInt(g.rawAmount) * BigInt(asset.multiplier)) / BigInt(asset.wadPrecision) : BigInt(g.rawAmount);
            const s = statusInfo(g);
            const link = g.kind === "claim-link";
            const openManage = link && sent && (s.label === "Awaiting claim" || s.label === "Expired");
            return (
              <li key={g.id} className="border-b border-line last:border-b-0">
                <div className="px-4 py-3 flex items-center gap-3 min-w-0">
                  <span className={`h-9 w-9 rounded-full inline-flex items-center justify-center shrink-0 ${sent ? "bg-surface-muted text-ink-secondary" : "bg-primary-soft text-primary"}`} aria-hidden>
                    {link ? <Link2 size={16} strokeWidth={1.75} /> : sent ? <ArrowUpRight size={16} strokeWidth={1.75} /> : <ArrowDownLeft size={16} strokeWidth={1.75} />}
                  </span>
                  {asset && <AssetLogo src={asset.logoURI} symbol={asset.symbol} size={30} />}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="font-medium text-[14px] num truncate">{`${formatTokenAmount(scaled, decimals)} ${asset?.underlying ?? "stock"}`}</span>
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </span>
                    <span className="block text-[12px] text-ink-secondary truncate">
                      {link ? (
                        sent ? "Claim link" : "Claimed from a link"
                      ) : sent ? (
                        <>
                          to <CounterpartyName address={g.recipient} />
                        </>
                      ) : (
                        <>
                          from <CounterpartyName address={g.sender} />
                        </>
                      )}
                      {g.message ? ` · “${g.message.slice(0, 40)}${g.message.length > 40 ? "…" : ""}”` : ""}
                      {" · "}
                      <TimeAgo value={g.createdAt} />
                    </span>
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    {openManage && (
                      <Link href={`/gifts/claim/${g.id}`} className="text-[12px] font-medium text-primary hover:underline">
                        Manage
                      </Link>
                    )}
                    <Link href={`/gifts/${g.id}`} className="text-[12px] font-medium text-primary hover:underline">
                      Receipt →
                    </Link>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {list.some((g) => g.kind === "claim-link" && g.sender.toLowerCase() === me && g.recipient === ZERO) && (
        <p className="px-4 py-3 text-[12px] text-ink-muted border-t border-line">Cancelling an unclaimed link (Manage) returns the stock to your wallet instantly.</p>
      )}
    </section>
  );
}
