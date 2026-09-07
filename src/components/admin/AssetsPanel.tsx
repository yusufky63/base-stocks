"use client";

import { useMutation } from "@tanstack/react-query";
import type { Address } from "viem";
import { Badge, Button, Module, ModuleHeader } from "@/components/ui/primitives";
import { AddressLabel } from "@/components/common/display";
import { adminFetch, utc, type Discovered } from "./client";

const ORDER: Record<Discovered["verification"], number> = { discovered: 0, verified: 1, disabled: 2 };

/**
 * Asset verification (spec §6): a token created onchain is not tradable until someone says so.
 *
 * The scan is a chain read over a few hundred thousand blocks, so it stays a button rather than
 * something the page does on load. Unreviewed tokens sort first, because they are the only rows
 * that need a decision.
 */
export function AssetsPanel({ token }: { token: string }) {
  const discover = useMutation({ mutationFn: () => adminFetch<{ discovered: Discovered[]; all: Discovered[] }>(token, "/api/admin/assets/discover", { method: "POST" }) });
  const setState = useMutation({
    mutationFn: (v: { address: Address; verification: Discovered["verification"] }) => adminFetch(token, "/api/admin/assets/discover", { method: "PATCH", body: JSON.stringify(v) }),
    onSuccess: () => discover.mutate(),
  });

  const all = [...(discover.data?.all ?? [])].sort((a, b) => ORDER[a.verification] - ORDER[b.verification] || b.blockNumber - a.blockNumber);
  const pending = all.filter((d) => d.verification === "discovered").length;

  return (
    <Module>
      <ModuleHeader
        title="Discovered tokens"
        action={
          <div className="flex items-center gap-2">
            {discover.data && <Badge tone={pending > 0 ? "warning" : "positive"}>{pending > 0 ? `${pending} to review` : "all reviewed"}</Badge>}
            <Button size="sm" loading={discover.isPending} onClick={() => discover.mutate()}>
              Scan B20Created
            </Button>
          </div>
        }
      />
      {discover.error && <p className="px-4 py-3 text-[13px] text-danger-fg">{(discover.error as Error).message}</p>}
      {setState.error && <p className="px-4 py-3 text-[13px] text-danger-fg">{(setState.error as Error).message}</p>}
      {!discover.data && !discover.isPending && <p className="px-4 py-4 text-[14px] text-ink-secondary">Run a scan to list tokens created onchain that are not in the curated registry.</p>}
      {discover.data && all.length === 0 && <p className="px-4 py-4 text-[14px] text-ink-secondary">The scan found nothing outside the curated registry.</p>}
      {all.map((d) => (
        <div key={d.address} className="flex flex-col md:flex-row md:items-center justify-between gap-3 px-4 py-3 border-b border-line last:border-b-0">
          <div className="min-w-0">
            <div className="font-medium text-[14px]">
              {d.symbol} <span className="text-ink-secondary font-normal">{d.name}</span>
              {d.eligible && <span className="ml-2 font-mono text-[10px] uppercase text-positive-fg">eligible · feed {d.chainlinkFeed?.slice(0, 8)}…</span>}
              {d.autoVerified && <span className="ml-2 font-mono text-[10px] uppercase text-primary">auto-verified</span>}
              {!d.eligible && d.reason && <span className="ml-2 font-mono text-[10px] text-ink-muted">{d.reason}</span>}
            </div>
            <AddressLabel address={d.address} explorer />
            <div className="font-mono text-[11px] text-ink-muted mt-0.5">
              block {d.blockNumber.toLocaleString()} · seen {utc(d.updatedAt)} UTC
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge tone={d.verification === "verified" ? "positive" : d.verification === "disabled" ? "danger" : "warning"}>{d.verification}</Badge>
            <Button size="sm" variant="secondary" disabled={d.verification === "verified" || setState.isPending} onClick={() => setState.mutate({ address: d.address, verification: "verified" })}>
              Verify
            </Button>
            <Button size="sm" variant="ghost" disabled={d.verification === "disabled" || setState.isPending} onClick={() => setState.mutate({ address: d.address, verification: "disabled" })}>
              Disable
            </Button>
          </div>
        </div>
      ))}
      <p className="px-4 py-3 text-[12px] text-ink-muted border-t border-line">Verified tokens still need a Chainlink feed and tags in the curated registry before they appear in Markets.</p>
    </Module>
  );
}
