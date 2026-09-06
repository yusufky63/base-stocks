"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type { Badge as BadgeT, CommunityBasket, Profile } from "@/domain/community";
import { apiGet } from "@/lib/client-api";
import { useAssets } from "@/hooks/queries";
import { bpsToPct, shortenAddress } from "@/lib/format";
import { Module, ModuleHeader, Badge, PageTitle } from "@/components/ui/primitives";
import { AddressLabel, AssetLogo } from "@/components/common/display";
import { AllocationBar, ColorDot } from "@/components/common/AllocationBar";
import { ShareButton } from "@/components/common/ShareSheet";
import { BasketRow } from "./CommunityView";
import { BadgeGrid } from "./BadgeGrid";

interface ProfileResponse {
  address: Address;
  profile: Profile;
  basename: string | null;
  badges: BadgeT[];
  baskets: CommunityBasket[];
  allocation: Array<{ assetAddress: Address; symbol: string; weightBps: number }>;
  positions: number | null;
}

/** Public page: Basename (or address) identity, allocation percentages, published baskets, badges. */
export function ProfileView({ refParam }: { refParam: string }) {
  const { data: assets } = useAssets();
  const { data, isLoading, isError } = useQuery({ queryKey: ["profile", refParam.toLowerCase()], queryFn: () => apiGet<ProfileResponse>(`/api/profiles/${refParam}`), staleTime: 30_000 });

  if (isLoading) return <div className="border border-line rounded-[8px] p-8 text-ink-secondary">Loading profile…</div>;
  if (isError || !data) return <div className="border border-line rounded-[8px] p-8 text-ink-secondary">Profile not found.</div>;
  const byId = new Map((assets?.assets ?? []).map((a) => [a.canonicalId, a]));
  const title = data.basename || shortenAddress(data.address);

  return (
    <div className="flex flex-col gap-6">
      <PageTitle
        index="Profile"
        title={title}
        lead={
          <span className="flex flex-col gap-1">
            <AddressLabel address={data.address} basename={data.basename} explorer />
            {data.profile.bio && <span>{data.profile.bio}</span>}
          </span>
        }
        action={
          <div className="flex gap-2 flex-wrap">
            <ShareButton path={`/u/${data.address}`} text={`${title} on BaseStocks`} title="Share profile" />
          </div>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6 items-start">
        <div className="flex flex-col gap-6">
          <Module ticks>
            <ModuleHeader index="A" title="Allocation" action={data.positions !== null ? <Badge>{data.positions} positions</Badge> : <Badge>private</Badge>} />
            {data.allocation.length === 0 ? (
              <p className="px-4 py-4 text-[14px] text-ink-secondary">{data.positions === null ? "This user keeps holdings private." : "No stock positions yet."}</p>
            ) : (
              <div className="p-4 flex flex-col gap-3">
                <AllocationBar legend={false} segments={data.allocation.map((h) => ({ key: h.assetAddress, label: h.symbol, weightBps: h.weightBps }))} />
                <ul className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {data.allocation.map((h) => {
                    const a = byId.get(h.assetAddress.toLowerCase());
                    return (
                      <li key={h.assetAddress}>
                        <Link href={`/stocks/${h.assetAddress}`} className="flex items-center gap-2 border border-line rounded-[6px] px-2 py-1.5 hover:border-line-strong transition-fast">
                          <ColorDot k={h.assetAddress} />
                          {a && <AssetLogo src={a.logoURI} symbol={a.symbol} size={22} />}
                          <span className="font-medium text-[13px]">{h.symbol}</span>
                          <span className="ml-auto font-mono num text-[12px] text-ink-secondary">{bpsToPct(h.weightBps)}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
                <p className="text-[12px] text-ink-muted">Percentages only; amounts are not shown.</p>
              </div>
            )}
          </Module>

          <Module>
            <ModuleHeader index="B" title="Published baskets" />
            {data.baskets.map((b) => (
              <BasketRow key={b.id} basket={b} byId={byId} />
            ))}
            {data.baskets.length === 0 && <p className="px-4 py-4 text-[14px] text-ink-secondary">No published baskets.</p>}
          </Module>
        </div>

        <div className="flex flex-col gap-6">
          <Module>
            <ModuleHeader index="C" title="Badges" />
            <BadgeGrid badges={data.badges} compact />
          </Module>
        </div>
      </div>
    </div>
  );
}
