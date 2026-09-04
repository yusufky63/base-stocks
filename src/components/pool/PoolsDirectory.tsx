"use client";

import { LinkButton, PageTitle } from "@/components/ui/primitives";
import { PoolList } from "./PoolList";

/**
 * The public pool directory. Only pools their creator chose to list appear here, and only a
 * verified one carries the check — anyone can name a pool "Official Coinbase giveaway", so the
 * badge, not the title, is what says a human looked at it.
 *
 * The list itself lives in `PoolList` because the Gifts page shows the same thing under a tab.
 */
export function PoolsDirectory() {
  return (
    <div className="flex flex-col gap-6">
      <PageTitle
        index="Pools"
        title="Open gift pools"
        lead="One deposit, many equal shares. Open a pool, take your one share, and the stock is yours — self-custodial, on Base."
        action={
          <LinkButton href="/gifts" variant="primary">
            Create a pool
          </LinkButton>
        }
      />

      <PoolList columns={3} />

      <p className="text-[12px] text-ink-muted">
        Pools are held by an ownerless contract: it can only pay a claimant their exact share or return the remainder to the creator. A creator without a lock badge can close their pool at any time.
      </p>
    </div>
  );
}
