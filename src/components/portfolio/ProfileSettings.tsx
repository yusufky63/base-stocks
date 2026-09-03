"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Address } from "viem";
import type { Badge as BadgeT, CommunityBasket, Profile } from "@/domain/community";
import { apiGet, apiPut } from "@/lib/client-api";
import { useAuth } from "@/hooks/useAuth";
import { Module, ModuleHeader, Button, Chip, Skeleton } from "@/components/ui/primitives";
import { Input } from "@/components/ui/Input";
import { ShareButton } from "@/components/common/ShareSheet";
import { SignInButton } from "@/components/layout/SignInButton";
import { BadgeGrid } from "@/components/community/BadgeGrid";
import { ReferralCard } from "@/components/community/ReferralCard";

interface ProfileResponse {
  address: Address;
  profile: Profile;
  basename: string | null;
  badges: BadgeT[];
  baskets: CommunityBasket[];
  referral: { invited: number; traded: number };
  positions: number | null;
}

interface Form {
  handle: string;
  displayName: string;
  bio: string;
  isPublic: boolean;
}

/**
 * Your public presence, edited from the Portfolio page: handle, name, bio, whether holdings
 * (percentages only) are visible, plus badges and referral stats. Saving needs a one-time SIWE sign-in.
 */
export function ProfileSettings({ address }: { address: Address }) {
  const auth = useAuth();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["profile", address.toLowerCase()], queryFn: () => apiGet<ProfileResponse>(`/api/profiles/${address}`), staleTime: 30_000 });
  const [form, setForm] = useState<Form | null>(null);
  const [loadedFor, setLoadedFor] = useState<string>("");
  // Seed the form once per loaded profile (render-time state adjustment; no effect needed).
  if (data && loadedFor !== data.address.toLowerCase()) {
    setLoadedFor(data.address.toLowerCase());
    setForm({ handle: data.profile.handle ?? "", displayName: data.profile.displayName ?? "", bio: data.profile.bio ?? "", isPublic: data.profile.isPublic });
  }
  const save = useMutation({
    mutationFn: async () => {
      if (!form) return null;
      await auth.ensureSignedIn();
      return apiPut<{ profile: Profile }>("/api/profiles/me", { handle: form.handle || undefined, displayName: form.displayName || undefined, bio: form.bio || undefined, isPublic: form.isPublic });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profile"] }),
  });

  const publicPath = `/u/${data?.profile.handle || address}`;
  const title = data?.profile.displayName || (data?.profile.handle ? `@${data.profile.handle}` : data?.basename || "Your profile");

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6 items-start">
      <Module>
        <ModuleHeader
          title="Public profile"
          action={
            <span className="flex items-center gap-2">
              <Link href={publicPath} className="text-[13px] text-primary font-medium">
                View page →
              </Link>
              <ShareButton path={publicPath} text={`${title} on BStocks`} title="Share profile" />
            </span>
          }
        />
        {isLoading || !form ? (
          <div className="p-4 flex flex-col gap-2">
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
          </div>
        ) : (
          <div className="p-4 flex flex-col gap-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Input label="Handle" value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value.replace(/[^a-z0-9_]/gi, "").toLowerCase() })} placeholder="alice" hint="Your page becomes /u/handle" />
              <Input label="Display name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Alice" />
              <div className="md:col-span-2">
                <Input label="Bio" value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value.slice(0, 200) })} placeholder="Long-term, boring, diversified." />
              </div>
            </div>
            <div className="flex items-center justify-between gap-4 border border-line rounded-[6px] px-3 py-2.5">
              <div>
                <div className="text-[14px] font-medium">Holdings on your page</div>
                <div className="text-[12px] text-ink-muted">Percentages only, never amounts. Private hides the allocation entirely.</div>
              </div>
              <div className="flex gap-2 shrink-0">
                <Chip active={form.isPublic} onClick={() => setForm({ ...form, isPublic: true })}>
                  Public
                </Chip>
                <Chip active={!form.isPublic} onClick={() => setForm({ ...form, isPublic: false })}>
                  Private
                </Chip>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>
                Save profile
              </Button>
              {!auth.isSignedIn && <SignInButton label="Sign in to save" />}
              {save.isSuccess && <span className="text-[13px] text-positive-fg">Saved.</span>}
              {save.error && <span className="text-[13px] text-danger-fg">{(save.error as Error).message}</span>}
            </div>
          </div>
        )}
      </Module>

      <div className="flex flex-col gap-6">
        <Module>
          <ModuleHeader title="Badges" />
          {data ? (
            <BadgeGrid badges={data.badges} compact />
          ) : (
            <div className="p-4">
              <Skeleton className="h-16" />
            </div>
          )}
        </Module>
        <Module>
          <ModuleHeader title="Referrals" action={<Link href="/community" className="text-[13px] text-primary font-medium">Community →</Link>} />
          {data ? (
            <ReferralCard address={data.address} invited={data.referral.invited} traded={data.referral.traded} owner />
          ) : (
            <div className="p-4">
              <Skeleton className="h-16" />
            </div>
          )}
        </Module>
      </div>
    </div>
  );
}
