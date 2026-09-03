"use client";

import { useAccount } from "wagmi";
import { useActivity } from "@/hooks/queries";
import { Module, ModuleHeader, Skeleton } from "@/components/ui/primitives";
import { ConnectButton } from "@/components/layout/ConnectButton";
import { ActivityList } from "./ActivityList";

export function ActivityView() {
  const { address, isConnected } = useAccount();
  const { data, isLoading, isError, refetch } = useActivity(address);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="eyebrow mb-2">05 — Activity</div>
        <h1 className="display text-[36px] md:text-[48px] leading-none">Activity</h1>
      </div>
      {!isConnected ? (
        <div className="border border-line rounded-[8px] p-6 flex flex-col gap-3 items-start">
          <p className="text-ink-secondary">Connect a wallet to see your buys, sells, sends and portfolio builds.</p>
          <ConnectButton />
        </div>
      ) : (
        <Module>
          <ModuleHeader title="Timeline" action={<button className="text-[13px] text-primary font-medium" onClick={() => refetch()}>Refresh</button>} />
          {isLoading && !data && (
            <div className="p-4 flex flex-col gap-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          )}
          {isError && <p className="px-4 py-4 text-[14px] text-danger-fg">Activity could not be loaded.</p>}
          {data && <ActivityList items={data} />}
          <p className="px-4 py-3 text-[12px] text-ink-muted border-t border-line">App records are marked “unverified” until a matching onchain transfer is found. Onchain history covers the most recent blocks reachable from the RPC.</p>
        </Module>
      )}
    </div>
  );
}
