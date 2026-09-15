"use client";

import { useState } from "react";
import type { Address } from "viem";
import { Globe, Heart, Layers, Plus, Repeat2, ShieldCheck, UserPlus, Wallet, X } from "lucide-react";
import type { B20AssetDTO } from "@/domain/asset";
import type { Quest, QuestType } from "@/domain/pool";
import { isSelfDeclared, isSingletonQuest } from "@/domain/pool";
import { BSTOCKS_X_HANDLE, isXPostUrl, normalizeXHandle } from "@/content/social";
import { isHttpUrl } from "@/lib/url";
import { MAX_POOL_QUESTS } from "@/lib/pool";
import { parseAmountSafe, toRaw } from "@/lib/b20/math";
import { formatShares } from "@/lib/gift/format";
import { XMark } from "@/components/brand/Logo";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Badge, Button, Skeleton, cx } from "@/components/ui/primitives";

/** A step list is only sendable once every entry carries what it needs. */
export function questsValid(quests: Quest[]): boolean {
  return quests.every((q) => {
    switch (q.type) {
      case "follow-x":
        return !!q.handle && q.handle.length > 0;
      case "repost-x":
      case "like-x":
        return !!q.tweetUrl && isXPostUrl(q.tweetUrl);
      case "visit-url":
        return !!q.url && isHttpUrl(q.url);
      case "hold-asset":
        return !!q.assetAddress && !!q.minRawAmount && BigInt(q.minRawAmount) > 0n;
      case "buy-asset":
        return !!q.assetAddress && (q.minUsd ?? 0) > 0;
      default:
        return true;
    }
  });
}

interface CatalogEntry {
  type: QuestType;
  label: string;
  icon: React.ReactNode;
  seed: (assets: B20AssetDTO[]) => Quest;
}

/** The raw minimum for "one share" of a stock, so a new Hold step starts with a figure that means something. */
function oneShareRaw(asset: B20AssetDTO | undefined): string {
  if (!asset) return "1";
  return toRaw(parseAmountSafe("1", asset.decimals), BigInt(asset.multiplier), BigInt(asset.wadPrecision)).toString();
}

const CHECKED_CATALOG: CatalogEntry[] = [
  { type: "hold-basename", label: "Own a Basename", icon: <ShieldCheck size={13} strokeWidth={1.75} />, seed: () => ({ type: "hold-basename" }) },
  { type: "sign-in", label: "Sign in", icon: <Wallet size={13} strokeWidth={1.75} />, seed: () => ({ type: "sign-in" }) },
  {
    type: "hold-asset",
    label: "Hold a stock",
    icon: <Layers size={13} strokeWidth={1.75} />,
    seed: (assets) => ({ type: "hold-asset", assetAddress: assets[0]?.address as Address, minRawAmount: oneShareRaw(assets[0]) }),
  },
  {
    type: "buy-asset",
    label: "Buy a stock",
    icon: <Wallet size={13} strokeWidth={1.75} />,
    seed: (assets) => ({ type: "buy-asset", assetAddress: assets[0]?.address as Address, minUsd: 5, withinDays: 30 }),
  },
];

const DECLARED_CATALOG: CatalogEntry[] = [
  { type: "follow-bstocks", label: `Follow @${BSTOCKS_X_HANDLE}`, icon: <XMark size={12} />, seed: () => ({ type: "follow-bstocks" }) },
  { type: "follow-x", label: "Follow an account", icon: <UserPlus size={13} strokeWidth={1.75} />, seed: () => ({ type: "follow-x", handle: "" }) },
  { type: "repost-x", label: "Repost a post", icon: <Repeat2 size={13} strokeWidth={1.75} />, seed: () => ({ type: "repost-x", tweetUrl: "" }) },
  { type: "like-x", label: "Like a post", icon: <Heart size={13} strokeWidth={1.75} />, seed: () => ({ type: "like-x", tweetUrl: "" }) },
  { type: "visit-url", label: "Visit a link", icon: <Globe size={13} strokeWidth={1.75} />, seed: () => ({ type: "visit-url", url: "", label: "" }) },
];

const ALL_CATALOG = [...CHECKED_CATALOG, ...DECLARED_CATALOG];

/**
 * What a creator asks of the people claiming their pool: a list they add to, not a fixed set of
 * checkboxes, so a campaign can name three accounts to follow and two links to read.
 *
 * The two grades are labelled per row for what they actually are. Steps checked on Base cannot be
 * talked into passing. The rest — X actions, link visits — are the claimant's own confirmation:
 * nobody can read a follow, a repost, a like or a page view from outside, so BStocks records who
 * said what and when and marks it `declared` on the roster. Whoever funds a campaign should be
 * able to see which half of their list would survive someone lying.
 */
export function QuestPicker({ assets, quests, onChange }: { assets: B20AssetDTO[]; quests: Quest[]; onChange: (q: Quest[]) => void }) {
  const [addOpen, setAddOpen] = useState(quests.length === 0);

  const set = (i: number, fields: Partial<Quest>) => onChange(quests.map((q, idx) => (idx === i ? { ...q, ...fields } : q)));
  const removeAt = (i: number) => onChange(quests.filter((_, idx) => idx !== i));
  const add = (entry: CatalogEntry) => {
    if (quests.length >= MAX_POOL_QUESTS) return;
    onChange([...quests, entry.seed(assets)]);
    setAddOpen(false);
  };

  if (assets.length === 0) return <Skeleton className="h-24" />;

  const declared = quests.filter((q) => isSelfDeclared(q.type)).length;
  const checked = quests.length - declared;
  const full = quests.length >= MAX_POOL_QUESTS;
  const canAdd = (entry: CatalogEntry) => !full && !(isSingletonQuest(entry.type) && quests.some((q) => q.type === entry.type));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Steps before claiming</span>
        <span className="font-mono text-[10px] text-ink-muted num">{quests.length > 0 ? `${checked} checked · ${declared} declared` : "none yet"}</span>
      </div>

      {/* No overflow-hidden anywhere on this path: the stock dropdown opens out of the card. */}
      {quests.length > 0 && (
        <ul className="border border-line rounded-[8px] bg-canvas">
          {quests.map((q, i) => {
            const entry = ALL_CATALOG.find((c) => c.type === q.type);
            const self = isSelfDeclared(q.type);
            return (
              <li key={`${q.type}-${i}`} className="border-b border-line last:border-b-0 first:rounded-t-[8px] last:rounded-b-[8px]">
                <div className="flex items-start gap-3 px-3.5 py-3">
                  <span className={cx("mt-0.5 shrink-0", self ? "text-ink-muted" : "text-positive-fg")}>{entry?.icon}</span>
                  <span className="min-w-0 flex-1 flex flex-col gap-2">
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-medium">{entry?.label ?? q.type}</span>
                      <Badge tone={self ? "neutral" : "positive"}>{self ? "Declared" : "Checked"}</Badge>
                    </span>
                    <StepFields assets={assets} quest={q} onChange={(fields) => set(i, fields)} />
                  </span>
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    aria-label={`Remove step: ${entry?.label ?? q.type}`}
                    className="shrink-0 mt-0.5 h-6 w-6 inline-flex items-center justify-center rounded-[4px] text-ink-muted hover:text-danger-fg hover:bg-surface transition-fast"
                  >
                    <X size={14} strokeWidth={2} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {addOpen || quests.length === 0 ? (
        <div className="border border-line rounded-[8px] bg-surface p-3.5 flex flex-col gap-3">
          <AddGroup title="Checked on Base" hint="Read from the chain — these cannot be faked." entries={CHECKED_CATALOG} canAdd={canAdd} onAdd={add} tone="positive" />
          <AddGroup title="Confirmed by the claimant" hint="Nobody can read these from outside, so they are recorded as the claimant's word." entries={DECLARED_CATALOG} canAdd={canAdd} onAdd={add} tone="muted" />
          {full && <p className="text-[12px] text-ink-muted">{`That is the maximum of ${MAX_POOL_QUESTS} steps. Remove one to add another.`}</p>}
        </div>
      ) : (
        <Button size="sm" variant="secondary" disabled={full} onClick={() => setAddOpen(true)} className="self-start">
          <Plus size={13} strokeWidth={2} /> Add another step
        </Button>
      )}

      {quests.length === 0 && <p className="text-[12px] text-danger-fg">Add at least one step, or switch this pool back to a link or an open one.</p>}
      {quests.length > 0 && !questsValid(quests) && <p className="text-[12px] text-danger-fg">Fill in the handle, post link or page link for every step above.</p>}
      {declared > 0 && checked === 0 && (
        <p className="text-[12px] text-ink-muted">
          Every step here is on the honour system. Add one checked step — a Basename is the strongest — if this campaign has to hold up against someone with fifty wallets.
        </p>
      )}
    </div>
  );
}

function AddGroup({
  title,
  hint,
  entries,
  canAdd,
  onAdd,
  tone,
}: {
  title: string;
  hint: string;
  entries: CatalogEntry[];
  canAdd: (e: CatalogEntry) => boolean;
  onAdd: (e: CatalogEntry) => void;
  tone: "positive" | "muted";
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className={cx("font-mono text-[10px] uppercase tracking-[0.12em]", tone === "positive" ? "text-positive-fg" : "text-ink-muted")}>{title}</span>
      <div className="flex flex-wrap gap-1.5">
        {entries.map((e) => (
          <button
            key={e.type}
            type="button"
            disabled={!canAdd(e)}
            onClick={() => onAdd(e)}
            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[6px] border border-line bg-canvas text-[12px] text-ink hover:border-line-strong disabled:opacity-40 disabled:cursor-not-allowed transition-fast"
          >
            <span className="text-ink-muted">{e.icon}</span>
            {e.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-ink-muted">{hint}</p>
    </div>
  );
}

/**
 * The minimum to hold, typed in shares and stored raw. The text is the creator's own while they
 * type; the raw figure is derived from it with the stock's multiplier and decimals, the same way
 * every other amount in the app goes from shares to base units.
 */
function HoldAmountField({ asset, quest, onChange }: { asset: B20AssetDTO | undefined; quest: Quest; onChange: (fields: Partial<Quest>) => void }) {
  const [text, setText] = useState(() => (asset && quest.minRawAmount ? formatShares(quest.minRawAmount, asset, 8) : ""));
  const update = (v: string) => {
    setText(v);
    if (!asset) return;
    const shares = parseAmountSafe(v, asset.decimals);
    onChange({ minRawAmount: shares > 0n ? toRaw(shares, BigInt(asset.multiplier), BigInt(asset.wadPrecision)).toString() : "0" });
  };
  return (
    <span className="w-[110px]">
      <Input value={text} onChange={(e) => update(e.target.value)} inputMode="decimal" aria-label={`Minimum ${asset?.underlying ?? "shares"} to hold`} placeholder="1" className="!h-9 text-[13px]" />
    </span>
  );
}

/** The inputs a given step needs, if any. */
function StepFields({ assets, quest, onChange }: { assets: B20AssetDTO[]; quest: Quest; onChange: (fields: Partial<Quest>) => void }) {
  switch (quest.type) {
    case "hold-asset": {
      const asset = assets.find((a) => a.address.toLowerCase() === (quest.assetAddress ?? "").toLowerCase());
      return (
        <span className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-ink-secondary">At least</span>
          <HoldAmountField key={quest.assetAddress ?? ""} asset={asset} quest={quest} onChange={onChange} />
          <span className="text-ink-secondary">shares of</span>
          <Select
            className="w-[140px]"
            size="sm"
            ariaLabel="Stock to hold"
            value={(quest.assetAddress ?? "") as string}
            onChange={(v) => {
              // A different stock has a different multiplier; the minimum starts over at one share of it.
              const next = assets.find((a) => a.address === v);
              onChange({ assetAddress: v as Address, minRawAmount: oneShareRaw(next) });
            }}
            options={assets.map((a) => ({ value: a.address as string, label: a.underlying, description: a.name }))}
          />
          <span className="text-ink-secondary">right now</span>
        </span>
      );
    }

    case "buy-asset":
      return (
        <span className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-ink-secondary">At least</span>
          <span className="w-[86px]">
            <Input
              value={String(quest.minUsd ?? "")}
              onChange={(e) => onChange({ minUsd: Math.max(1, Number(e.target.value.replace(/[^\d.]/g, "")) || 1) })}
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
            value={(quest.assetAddress ?? "") as string}
            onChange={(v) => onChange({ assetAddress: v as Address })}
            options={assets.map((a) => ({ value: a.address as string, label: a.underlying, description: a.name }))}
          />
          <span className="text-ink-secondary">in the last 30 days</span>
        </span>
      );

    case "follow-x":
      return (
        <span className="w-full max-w-[280px]">
          <Input
            value={quest.handle ?? ""}
            onChange={(e) => onChange({ handle: normalizeXHandle(e.target.value) })}
            placeholder="yourhandle"
            prefix="@"
            aria-label="X handle to follow"
            className="!h-9 text-[13px]"
          />
        </span>
      );

    case "repost-x":
    case "like-x":
      return (
        <span className="w-full">
          <Input
            value={quest.tweetUrl ?? ""}
            onChange={(e) => onChange({ tweetUrl: e.target.value.trim() })}
            placeholder="https://x.com/you/status/…"
            aria-label="Link to the post"
            error={quest.tweetUrl && !isXPostUrl(quest.tweetUrl) ? "That is not a link to a post." : undefined}
            className="!h-9 text-[13px]"
          />
        </span>
      );

    case "visit-url":
      return (
        <span className="flex flex-col sm:flex-row gap-2 w-full">
          <span className="flex-1 min-w-0">
            <Input
              value={quest.url ?? ""}
              onChange={(e) => onChange({ url: e.target.value.trim() })}
              placeholder="https://yoursite.com"
              aria-label="Link to visit"
              error={quest.url && !isHttpUrl(quest.url) ? "Links must start with https://" : undefined}
              className="!h-9 text-[13px]"
            />
          </span>
          <span className="w-full sm:w-[200px]">
            <Input
              value={quest.label ?? ""}
              onChange={(e) => onChange({ label: e.target.value.slice(0, 60) })}
              placeholder="Read the launch post"
              aria-label="What to call this step"
              className="!h-9 text-[13px]"
            />
          </span>
        </span>
      );

    default:
      return null;
  }
}
