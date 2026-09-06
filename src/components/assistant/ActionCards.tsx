"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { parseUnits } from "viem";
import Link from "next/link";
import type { AssistantAction, TradeAction } from "@/lib/assistant/schema";
import { apiPost, ApiError, type TradeQuoteSummary } from "@/lib/client-api";
import { useAssets } from "@/hooks/queries";
import { useSlippage } from "@/hooks/useSettings";
import { useRecentBaskets } from "@/hooks/useRecentBaskets";
import { automateHref, giftBasketHref } from "@/lib/automate-link";
import { USDC_ALLOCATION_KEY } from "@/domain/portfolio";
import { formatUsd, timeAgo } from "@/lib/format";
import { Badge, Button, KeyValue, Module } from "@/components/ui/primitives";
import { AssetLogo } from "@/components/common/display";
import { ConnectButton } from "@/components/layout/ConnectButton";
import { TradeReviewSheet } from "@/components/trade/TradeReviewSheet";
import { USDC_DECIMALS } from "@/config/chain";

/**
 * The cards an assistant turn can attach. Every card is a handoff to an existing, hardened
 * signing surface — the trade review sheet in place, or a prefilled page. Nothing here signs
 * or sends anything by itself.
 */
export function ActionCard({ action }: { action: AssistantAction }) {
  switch (action.kind) {
    case "trade":
      return <TradeDraftCard action={action} />;
    case "basket":
      return <BasketDraftCard action={action} />;
    case "autoinvest":
      return <AutoInvestDraftCard action={action} />;
    case "gift":
      return <GiftDraftCard action={action} />;
    case "earn":
      return <EarnDraftCard action={action} />;
    case "news":
      return <NewsCard action={action} />;
  }
}

/** Headlines with their real links, straight from the news service. */
function NewsCard({ action }: { action: Extract<AssistantAction, { kind: "news" }> }) {
  if (action.items.length === 0) return null;
  const label = action.scope === "stock" ? `${action.symbol ?? "Stock"} headlines` : action.scope === "ecosystem" ? "Base ecosystem" : "Market headlines";
  return (
    <Module className="mt-2">
      <div className="px-3 py-2 border-b border-line">
        <span className="eyebrow">{label}</span>
      </div>
      <ul className="divide-y divide-line">
        {action.items.map((n) => (
          <li key={n.url}>
            <a href={n.url} target="_blank" rel="noopener noreferrer" className="block px-3 py-2 group hover:bg-surface transition-fast">
              <span className="block text-[12.5px] leading-snug text-ink group-hover:text-primary transition-fast">{n.title}</span>
              <span className="block font-mono text-[10px] uppercase tracking-[0.06em] text-ink-muted mt-0.5">
                {n.ticker ? `${n.ticker} · ` : ""}
                {n.source} · {timeAgo(n.publishedAt)}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </Module>
  );
}

function CardShell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Module className="mt-2">
      <div className="px-3 py-2 border-b border-line flex items-center justify-between gap-2">
        <span className="eyebrow">{label}</span>
        <Badge>Draft</Badge>
      </div>
      <div className="p-3 flex flex-col gap-2">{children}</div>
    </Module>
  );
}

function SignNote() {
  return <p className="text-[11px] text-ink-muted">Nothing happens until you sign in your wallet.</p>;
}

function TradeDraftCard({ action }: { action: TradeAction }) {
  const { data: assetsData } = useAssets();
  const { address } = useAccount();
  const { slippageBps } = useSlippage();
  const [summary, setSummary] = useState<TradeQuoteSummary | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const asset = assetsData?.assets.find((a) => a.address.toLowerCase() === action.assetAddress.toLowerCase());
  const buy = action.side === "buy";
  const sellAmount = asset ? (buy ? parseUnits(String(action.amountUsd ?? 0), USDC_DECIMALS) : parseUnits((action.quantity ?? 0).toFixed(Math.min(8, asset.decimals)), asset.decimals)) : 0n;

  const openReview = async () => {
    if (!asset || sellAmount <= 0n) return;
    setLoading(true);
    setError(null);
    try {
      const s = await apiPost<TradeQuoteSummary>("/api/trade/price", { side: action.side, assetAddress: asset.address, sellAmount: sellAmount.toString(), payWith: buy ? action.payWith : undefined, taker: address, slippageBps });
      setSummary(s);
      setReviewOpen(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not fetch a quote. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <CardShell label={buy ? "Buy draft" : "Sell draft"}>
      <div className="flex items-center gap-2.5">
        <AssetLogo src={asset?.logoURI} symbol={action.symbol} size={30} />
        <div className="min-w-0">
          <div className="text-[14px] font-medium truncate">
            {buy ? `Buy ${action.symbol}` : `Sell ${action.quantity} ${action.symbol}`}
          </div>
          <div className="text-[12px] text-ink-secondary">{buy ? `${formatUsd(action.amountUsd ?? 0)} · pay with ${action.payWith}` : "receive USDC"}</div>
        </div>
      </div>
      {action.indicative && (
        <div className="flex flex-col">
          <KeyValue k="Estimated" v={`≈ ${action.indicative.estOut}`} />
          {action.indicative.priceUsd !== null && <KeyValue k="Indicative price" v={formatUsd(action.indicative.priceUsd)} />}
          <KeyValue k="Route" v={action.indicative.provider} />
        </div>
      )}
      {error && <p className="text-[12px] text-danger-fg">{error}</p>}
      {address ? (
        <Button size="sm" onClick={() => void openReview()} loading={loading} disabled={!asset}>
          Review &amp; sign
        </Button>
      ) : (
        <ConnectButton size="sm" />
      )}
      <SignNote />
      {asset && summary && (
        <TradeReviewSheet open={reviewOpen} onClose={() => setReviewOpen(false)} side={action.side} asset={asset} summary={summary} sellAmount={sellAmount} slippageBps={slippageBps} payWith={buy ? action.payWith : undefined} payUsd={buy && action.payWith === "ETH" ? action.amountUsd : undefined} provider={summary.provider} />
      )}
    </CardShell>
  );
}

function BasketDraftCard({ action }: { action: Extract<AssistantAction, { kind: "basket" }> }) {
  const router = useRouter();
  const { data: assetsData } = useAssets();
  const { saveDraft } = useRecentBaskets();
  const { intent } = action;
  const label = (addr: string) => (addr === USDC_ALLOCATION_KEY ? "USDC" : (assetsData?.assets.find((a) => a.canonicalId === addr.toLowerCase())?.underlying ?? "?"));

  return (
    <CardShell label="Basket draft">
      <div className="text-[14px] font-medium">{intent.name}</div>
      <div className="flex flex-wrap gap-1">
        {intent.allocations.map((a) => (
          <span key={String(a.assetAddress)} className="h-6 px-2 inline-flex items-center rounded-[4px] border border-line font-mono text-[11px]">
            {label(String(a.assetAddress))} {(a.weightBps / 100).toFixed(0)}%
          </span>
        ))}
      </div>
      {intent.notes && <p className="text-[12px] text-ink-secondary border-l-2 border-primary pl-2">{intent.notes}</p>}
      <Button
        size="sm"
        onClick={() => {
          saveDraft({ id: "draft", name: intent.name, allocations: intent.allocations, source: "ai", savedAt: Date.now() });
          router.push("/build");
        }}
      >
        Open in Build
      </Button>
      <SignNote />
    </CardShell>
  );
}

function AutoInvestDraftCard({ action }: { action: Extract<AssistantAction, { kind: "autoinvest" }> }) {
  const { draft } = action;
  const allocations = draft.type === "recurring-buy" && draft.assetAddress ? [{ assetAddress: draft.assetAddress as `0x${string}`, weightBps: 10_000 }] : (draft.allocations ?? []);
  const href = `${automateHref(allocations, draft.basketName ?? draft.symbol)}${allocations.length ? "&" : "?"}usd=${draft.amountUsd}&cadence=${draft.cadenceDays}`;
  return (
    <CardShell label="AutoInvest draft">
      <div className="text-[14px] font-medium">{draft.type === "recurring-buy" ? `${formatUsd(draft.amountUsd)} of ${draft.symbol ?? "?"}` : `${formatUsd(draft.amountUsd)} into ${draft.basketName ?? "a basket"}`}</div>
      <KeyValue k="Cadence" v={`every ${draft.cadenceDays} day${draft.cadenceDays === 1 ? "" : "s"}`} />
      {draft.notes && <p className="text-[12px] text-ink-secondary border-l-2 border-primary pl-2">{draft.notes}</p>}
      <Button size="sm" onClick={() => (window.location.href = href)}>
        Open in AutoInvest
      </Button>
      <SignNote />
    </CardShell>
  );
}

function GiftDraftCard({ action }: { action: Extract<AssistantAction, { kind: "gift" }> }) {
  const { data: assetsData } = useAssets();
  const asset = assetsData?.assets.find((a) => a.address.toLowerCase() === action.assetAddress.toLowerCase());
  return (
    <CardShell label="Gift draft">
      <div className="flex items-center gap-2.5">
        <AssetLogo src={asset?.logoURI} symbol={action.symbol} size={30} />
        <div className="min-w-0">
          <div className="text-[14px] font-medium truncate">{action.amountUsd ? `${formatUsd(action.amountUsd)} of ${action.symbol}` : `${action.quantity} ${action.symbol}`}</div>
          <div className="text-[12px] text-ink-secondary truncate">{action.recipient ? `to ${action.recipient}` : "as a claim link"}</div>
        </div>
      </div>
      <Link href={giftBasketHref([{ assetAddress: action.assetAddress, weightBps: 10_000 }], `Gift ${action.symbol}`)} className="contents">
        <Button size="sm" full>
          Open the gift flow
        </Button>
      </Link>
      <SignNote />
    </CardShell>
  );
}

function EarnDraftCard({ action }: { action: Extract<AssistantAction, { kind: "earn" }> }) {
  return (
    <CardShell label="Earn draft">
      <div className="text-[14px] font-medium">Deposit {formatUsd(action.amountUsd)} USDC</div>
      <KeyValue k="Venue" v={`${action.provider} · ${action.title}`} mono={false} />
      {action.variableApy !== undefined && <KeyValue k="Variable APY" v={`${action.variableApy.toFixed(2)}%`} />}
      <Link href="/earn" className="contents">
        <Button size="sm" full>
          Open Earn
        </Button>
      </Link>
      <SignNote />
    </CardShell>
  );
}
