"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Address } from "viem";
import type { Badge as BadgeT, Profile } from "@/domain/community";
import { apiGet, apiPut } from "@/lib/client-api";
import { useAuth } from "@/hooks/useAuth";
import { shortenAddress } from "@/lib/format";
import { Module, ModuleHeader, Chip, Skeleton } from "@/components/ui/primitives";
import { AddressLabel } from "@/components/common/display";
import { ShareButton } from "@/components/common/ShareSheet";
import { SignInButton } from "@/components/layout/SignInButton";
import { BadgeGrid } from "@/components/community/BadgeGrid";

interface ProfileResponse {
  address: Address;
  profile: Profile;
  basename: string | null;
  badges: BadgeT[];
  positions: number | null;
}

/**
 * Your page, edited from the Portfolio tab. Identity is the wallet's Basename (or address) —
 * nothing to configure. The only choice is whether the page shows your allocation percentages.
 */
export function ProfileSettings({ address }: { address: Address }) {
  const auth = useAuth();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["profile", address.toLowerCase()], queryFn: () => apiGet<ProfileResponse>(`/api/profiles/${address}`), staleTime: 30_000 });
  const [isPublic, setIsPublic] = useState<boolean | null>(null);
  const effectivePublic = isPublic ?? data?.profile.isPublic ?? true;
  const save = useMutation({
    mutationFn: async (next: boolean) => {
      await auth.ensureSignedIn();
      return apiPut<{ profile: Profile }>("/api/profiles/me", { isPublic: next });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profile"] }),
  });
  const choose = (next: boolean) => {
    setIsPublic(next);
    save.mutate(next);
  };

  const publicPath = `/u/${address}`;
  const title = data?.basename || shortenAddress(address);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6 items-start">
      <Module>
        <ModuleHeader
          title="Your page"
          action={
            <span className="flex items-center gap-2">
              <Link href={publicPath} className="text-[13px] text-primary font-medium">
                View page →
              </Link>
              <ShareButton path={publicPath} text={`${title} on BaseStocks`} title="Share your page" />
            </span>
          }
        />
        {isLoading ? (
          <div className="p-4 flex flex-col gap-2">
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
          </div>
        ) : (
          <div className="p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[14px] font-medium">{title}</div>
                <div className="text-[12px] text-ink-muted">Your page shows your Basename when the wallet has one, otherwise the address.</div>
              </div>
              <AddressLabel address={address} basename={data?.basename} />
            </div>
            <div className="flex items-center justify-between gap-4 border border-line rounded-[6px] px-3 py-2.5">
              <div>
                <div className="text-[14px] font-medium">Holdings on your page</div>
                <div className="text-[12px] text-ink-muted">Percentages only, never amounts. Private hides the allocation entirely.</div>
              </div>
              <div className="flex gap-2 shrink-0">
                <Chip active={effectivePublic} onClick={() => choose(true)} disabled={save.isPending}>
                  Public
                </Chip>
                <Chip active={!effectivePublic} onClick={() => choose(false)} disabled={save.isPending}>
                  Private
                </Chip>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {!auth.isSignedIn && <SignInButton label="Sign in to save" />}
              {save.isSuccess && <span className="text-[13px] text-positive-fg">Saved.</span>}
              {save.error && <span className="text-[13px] text-danger-fg">{(save.error as Error).message}</span>}
            </div>
          </div>
        )}
      </Module>

      <Module>
        <ModuleHeader title="Badges" action={<Link href="/community" className="text-[13px] text-primary font-medium">Community →</Link>} />
        {data ? (
          <BadgeGrid badges={data.badges} compact />
        ) : (
          <div className="p-4">
            <Skeleton className="h-16" />
          </div>
        )}
      </Module>
    </div>
  );
}
