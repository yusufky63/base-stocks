"use client";

import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import type { ActivityItem } from "@/domain/activity";
import { useActivity } from "@/hooks/queries";
import { Button, Chip, Module, ModuleHeader, Skeleton } from "@/components/ui/primitives";
import { Select } from "@/components/ui/Select";
import { ConnectButton } from "@/components/layout/ConnectButton";
import { ActivityList } from "./ActivityList";
import { PublicFeed } from "./PublicFeed";

type KindFilter = "all" | "trades" | "gifts" | "earn" | "other";
const KIND_OF: Record<ActivityItem["type"], KindFilter> = {
  buy: "trades",
  sell: "trades",
  "portfolio-build": "trades",
  "auto-invest": "trades",
  send: "gifts",
  receive: "gifts",
  "pool-create": "gifts",
  "pool-claim": "gifts",
  "earn-supply": "earn",
  "earn-withdraw": "earn",
  "earn-liquidity": "earn",
  "earn-collect": "earn",
  approve: "other",
  unknown: "other",
};
const KINDS: Array<{ value: KindFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "trades", label: "Trades" },
  { value: "gifts", label: "Gifts & pools" },
  { value: "earn", label: "Earn" },
];
const PAGE = 50;

const bare = (s: string | undefined) => (s ?? "").replace(/c$/, "");

/** Which stocks a row is about: its own, and every leg's inside a grouped row. */
function symbolsOf(it: ActivityItem): string[] {
  const out = new Set<string>();
  if (it.symbol) out.add(bare(it.symbol));
  for (const l of it.legs ?? []) if (l.symbol) out.add(bare(l.symbol));
  return [...out];
}

/**
 * The wallet's own timeline, with a kind filter, a stock filter and fifty rows at a time. All of
 * it happens on the rows already loaded: the timeline is one request, and narrowing it costs
 * nothing more.
 */
export function ActivityView() {
  const { address, isConnected } = useAccount();
  const { data, isLoading, isError, refetch } = useActivity(address);
  const [kind, setKind] = useState<KindFilter>("all");
  const [stock, setStock] = useState<string>("");
  const [shown, setShown] = useState(PAGE);

  const stocks = useMemo(() => {
    const set = new Set<string>();
    for (const it of data ?? []) for (const s of symbolsOf(it)) set.add(s);
    return [...set].sort();
  }, [data]);

  const filtered = useMemo(() => {
    const list = data ?? [];
    return list.filter((it) => (kind === "all" || KIND_OF[it.type] === kind) && (!stock || symbolsOf(it).includes(stock)));
  }, [data, kind, stock]);
  const visible = filtered.slice(0, shown);
  const filtering = kind !== "all" || !!stock;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="eyebrow mb-2">05 — Activity</div>
        <h1 className="display text-[36px] md:text-[48px] leading-none">Activity</h1>
      </div>
      {!isConnected ? (
        <>
          <div className="border border-line rounded-[8px] p-6 flex flex-col gap-3 items-start">
            <p className="text-ink-secondary">Connect a wallet to see your buys, sells, sends and portfolio builds.</p>
            <ConnectButton />
          </div>
          <PublicFeed limit={20} title="What everyone is doing" />
        </>
      ) : (
        <Module>
          <ModuleHeader
            title="Timeline"
            action={
              <button className="text-[13px] text-primary font-medium" onClick={() => refetch()}>
                Refresh
              </button>
            }
          />
          {(data?.length ?? 0) > 0 && (
            <div className="px-4 py-2.5 border-b border-line flex flex-wrap items-center gap-2">
              {KINDS.map((k) => (
                <Chip
                  key={k.value}
                  active={kind === k.value}
                  onClick={() => {
                    setKind(k.value);
                    setShown(PAGE);
                  }}
                  className="h-8 min-h-[32px] px-2.5 text-[12px]"
                >
                  {k.label}
                </Chip>
              ))}
              {stocks.length > 1 && (
                <Select<string>
                  className="ml-auto w-[150px]"
                  size="sm"
                  ariaLabel="Filter by stock"
                  placeholder="Every stock"
                  value={stock}
                  onChange={(v) => {
                    setStock(v);
                    setShown(PAGE);
                  }}
                  options={[{ value: "", label: "Every stock" }, ...stocks.map((s) => ({ value: s, label: s }))]}
                />
              )}
              {filtering && (
                <span className="font-mono num text-[12px] text-ink-secondary whitespace-nowrap">
                  {filtered.length} of {data?.length ?? 0}
                </span>
              )}
            </div>
          )}
          {isLoading && !data && (
            <div className="p-4 flex flex-col gap-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          )}
          {isError && <p className="px-4 py-4 text-[14px] text-danger-fg">Activity could not be loaded.</p>}
          {data && (filtering && filtered.length === 0 ? <p className="px-4 py-4 text-[14px] text-ink-secondary">Nothing matches this filter.</p> : <ActivityList items={visible} emptyHint="story" />)}
          {filtered.length > shown && (
            <div className="px-4 py-3 border-t border-line">
              <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + PAGE)}>
                Show {Math.min(PAGE, filtered.length - shown)} more · {filtered.length - shown} left
              </Button>
            </div>
          )}
          <p className="px-4 py-3 text-[12px] text-ink-muted border-t border-line">One transaction is one row: a basket, an auto-invest run or a batch of gift links shows once, with its legs inside. Every row the app recorded is checked against the transaction receipt on Base; “Pending” means the receipt is not in yet. Transfers nobody recorded here are read from the chain for the most recent blocks. The “tx” on a row opens it on Basescan.</p>
        </Module>
      )}
    </div>
  );
}
