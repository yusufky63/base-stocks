"use client";

import { useState } from "react";
import type { Address } from "viem";
import { Link2, ShieldCheck } from "lucide-react";
import type { B20AssetDTO } from "@/domain/asset";
import type { Quest, QuestType } from "@/domain/pool";
import { isSelfDeclared } from "@/domain/pool";
import { BSTOCKS_X_HANDLE, isXPostUrl, normalizeXHandle } from "@/content/social";
import { XMark } from "@/components/brand/Logo";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Skeleton, cx } from "@/components/ui/primitives";

/** A quest list is only sendable once every enabled step carries what it needs. */
export function questsValid(quests: Quest[]): boolean {
  return quests.every((q) => {
    if (q.type === "follow-x") return !!q.handle && q.handle.length > 0;
    if (q.type === "repost-x" || q.type === "like-x") return !!q.tweetUrl && isXPostUrl(q.tweetUrl);
    if (q.type === "hold-asset") return !!q.assetAddress && !!q.minRawAmount;
    if (q.type === "buy-asset") return !!q.assetAddress && (q.minUsd ?? 0) > 0;
    return true;
  });
}

function Row({
  on,
  onToggle,
  icon,
  children,
}: {
  on: boolean;
  onToggle: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li className={cx("border-b border-line last:border-b-0 transition-fast", on && "bg-primary-soft/30")}>
      <div className="flex items-start gap-3 px-3.5 py-3">
        <input type="checkbox" checked={on} onChange={onToggle} className="mt-1 accent-[var(--primary)] w-4 h-4 shrink-0" />
        {icon && <span className="mt-0.5 shrink-0 text-ink-muted">{icon}</span>}
        <span className="min-w-0 flex-1 flex flex-col gap-2">{children}</span>
      </div>
    </li>
  );
}

/**
 * What a creator can ask of the people claiming their pool.
 *
 * The two groups are labelled for what they actually are. Onchain steps are read from Base and
 * cannot be talked into passing. X steps are confirmed by the claimant: X's free API does not
 * expose follows, reposts or likes, so BStocks records who said they did what and when, and shows
 * that as declared rather than verified on the roster. Anyone building a campaign should know
 * which half of their list is which before they fund it.
 */
export function QuestPicker({ assets, quests, onChange }: { assets: B20AssetDTO[]; quests: Quest[]; onChange: (q: Quest[]) => void }) {
  const [buyAsset, setBuyAsset] = useState<string>(assets[0]?.address ?? "");
  const [buyUsd, setBuyUsd] = useState("5");

  const has = (type: QuestType) => quests.some((q) => q.type === type);
  const get = (type: QuestType) => quests.find((q) => q.type === type);
  const remove = (type: QuestType) => onChange(quests.filter((q) => q.type !== type));
  const add = (q: Quest) => onChange([...quests, q]);
  const patch = (type: QuestType, fields: Partial<Quest>) => onChange(quests.map((q) => (q.type === type ? { ...q, ...fields } : q)));
  const toggle = (type: QuestType, seed: Quest) => (has(type) ? remove(type) : add(seed));

  if (assets.length === 0) return <Skeleton className="h-24" />;

  const declared = quests.filter((q) => isSelfDeclared(q.type)).length;
  const checked = quests.length - declared;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">What people must do first</span>
        <span className="font-mono text-[10px] text-ink-muted num">{quests.length > 0 ? `${checked} checked · ${declared} declared` : "none yet"}</span>
      </div>

      {/* --- checked onchain --- */}
      <div className="border border-line rounded-[8px] overflow-hidden">
        <div className="flex items-center gap-2 px-3.5 py-2 bg-surface border-b border-line">
          <ShieldCheck size={13} strokeWidth={1.75} className="text-positive-fg" />
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Checked on Base</span>
        </div>
        <ul>
          <Row on={has("hold-basename")} onToggle={() => toggle("hold-basename", { type: "hold-basename" })}>
            <span className="text-[13px] font-medium">Own a Basename</span>
            <span className="text-[12px] text-ink-muted">Costs money to get, so it is the strongest filter you have against one person with fifty wallets.</span>
          </Row>
          <Row on={has("sign-in")} onToggle={() => toggle("sign-in", { type: "sign-in" })}>
            <span className="text-[13px] font-medium">Sign in to BStocks</span>
            <span className="text-[12px] text-ink-muted">Proves the wallet is theirs. Free to do, so it stops nobody on its own.</span>
          </Row>
          <Row on={has("buy-asset")} onToggle={() => toggle("buy-asset", { type: "buy-asset", assetAddress: buyAsset as Address, minUsd: Math.max(1, Number(buyUsd) || 5), withinDays: 30 })}>
            <span className="text-[13px] font-medium">Buy a stock first</span>
            <span className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="text-ink-secondary">At least</span>
              <span className="w-[86px]">
                <Input
                  value={buyUsd}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^\d.]/g, "");
                    setBuyUsd(v);
                    if (has("buy-asset")) patch("buy-asset", { minUsd: Math.max(1, Number(v) || 1) });
                  }}
                  inputMode="decimal"
                  prefix="$"
                  aria-label="Minimum purchase in dollars"
                  className="!h-9 text-[13px]"
                />
              </span>
              <span className="text-ink-secondary">of</span>
              <Select
                className="w-[140px]"
                size="sm"
                ariaLabel="Stock to buy"
                value={(get("buy-asset")?.assetAddress ?? buyAsset) as string}
                onChange={(v) => {
                  setBuyAsset(v);
                  if (has("buy-asset")) patch("buy-asset", { assetAddress: v as Address });
                }}
                options={assets.map((a) => ({ value: a.address as string, label: a.underlying, description: a.name }))}
              />
              <span className="text-ink-secondary">in 30 days</span>
            </span>
            <span className="text-[12px] text-ink-muted">Re-read from the transaction receipt, so a purchase that never happened cannot be claimed.</span>
          </Row>
        </ul>
      </div>

      {/* --- confirmed by the claimant --- */}
      <div className="border border-line rounded-[8px] overflow-hidden">
        <div className="flex items-center gap-2 px-3.5 py-2 bg-surface border-b border-line">
          <XMark size={12} className="text-ink-secondary" />
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Confirmed by the claimant</span>
        </div>
        <ul>
          <Row on={has("follow-bstocks")} onToggle={() => toggle("follow-bstocks", { type: "follow-bstocks" })}>
            <span className="text-[13px] font-medium">{`Follow @${BSTOCKS_X_HANDLE}`}</span>
            <span className="text-[12px] text-ink-muted">Opens our profile, then they confirm here.</span>
          </Row>
          <Row on={has("follow-x")} onToggle={() => toggle("follow-x", { type: "follow-x", handle: "" })}>
            <span className="text-[13px] font-medium">Follow another account</span>
            <span className="w-full max-w-[280px]">
              <Input
                value={get("follow-x")?.handle ?? ""}
                onChange={(e) => patch("follow-x", { handle: normalizeXHandle(e.target.value) })}
                placeholder="yourhandle"
                prefix="@"
                disabled={!has("follow-x")}
                aria-label="X handle to follow"
                className="!h-9 text-[13px]"
              />
            </span>
          </Row>
          <Row on={has("repost-x")} onToggle={() => toggle("repost-x", { type: "repost-x", tweetUrl: "" })} icon={<Link2 size={13} strokeWidth={1.75} />}>
            <span className="text-[13px] font-medium">Repost a post</span>
            <span className="w-full">
              <Input
                value={get("repost-x")?.tweetUrl ?? ""}
                onChange={(e) => patch("repost-x", { tweetUrl: e.target.value.trim() })}
                placeholder="https://x.com/you/status/…"
                disabled={!has("repost-x")}
                aria-label="Link to the post to repost"
                error={has("repost-x") && !!get("repost-x")?.tweetUrl && !isXPostUrl(get("repost-x")!.tweetUrl!) ? "That is not a link to a post." : undefined}
                className="!h-9 text-[13px]"
              />
            </span>
          </Row>
          <Row on={has("like-x")} onToggle={() => toggle("like-x", { type: "like-x", tweetUrl: "" })} icon={<Link2 size={13} strokeWidth={1.75} />}>
            <span className="text-[13px] font-medium">Like a post</span>
            <span className="w-full">
              <Input
                value={get("like-x")?.tweetUrl ?? ""}
                onChange={(e) => patch("like-x", { tweetUrl: e.target.value.trim() })}
                placeholder="https://x.com/you/status/…"
                disabled={!has("like-x")}
                aria-label="Link to the post to like"
                error={has("like-x") && !!get("like-x")?.tweetUrl && !isXPostUrl(get("like-x")!.tweetUrl!) ? "That is not a link to a post." : undefined}
                className="!h-9 text-[13px]"
              />
            </span>
          </Row>
        </ul>
        <p className="px-3.5 py-2.5 text-[11px] text-ink-muted border-t border-line">
          X does not let anyone read a follow, a repost or a like from outside, so these are recorded as the claimant&apos;s own word — with a wallet and a timestamp — and marked “declared” on your roster. Pair one with a checked step above if a campaign has to hold up.
        </p>
      </div>

      {quests.length === 0 && <p className="text-[12px] text-danger-fg">Pick at least one step, or switch this pool back to a link or an open one.</p>}
      {quests.length > 0 && !questsValid(quests) && <p className="text-[12px] text-danger-fg">Fill in the handle or post link for every X step you turned on.</p>}
    </div>
  );
}
