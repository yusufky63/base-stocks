"use client";

import Link from "next/link";
import { ArrowRight, ArrowUpRight, BadgeCheck, Gift } from "lucide-react";
import { useAccount } from "wagmi";
import type { GiftParty, GiftReceipt } from "@/services/gift-service";
import { giftAmountLabel, giftPartyLabel } from "@/services/gift-service";
import { AssetLogo, TxLink } from "@/components/common/display";
import { Avatar } from "@/components/common/RecipientCard";
import { ShareButton } from "@/components/common/ShareSheet";
import { Badge, LinkButton, Module, PageTitle } from "@/components/ui/primitives";
import { shortenAddress } from "@/lib/format";

/** Public receipt page for a gift. The viewer's role (sender / recipient / visitor) changes the share text and CTA. */
export function GiftReceiptView({ receipt }: { receipt: GiftReceipt }) {
  const { address } = useAccount();
  const { gift, asset } = receipt;
  const amount = giftAmountLabel(receipt);
  const me = address?.toLowerCase();
  const role = me === gift.recipient.toLowerCase() ? "recipient" : me === gift.sender.toLowerCase() ? "sender" : "visitor";
  const senderName = giftPartyLabel(receipt.sender);
  const recipientName = giftPartyLabel(receipt.recipient);
  const shareText =
    role === "recipient"
      ? `I received ${amount} as a gift from ${senderName} on BStocks — tokenized stocks on Base.`
      : role === "sender"
        ? `I just gifted ${amount} (a tokenized stock on Base) to ${recipientName} with BStocks.`
        : `${senderName} gifted ${amount} to ${recipientName} on BStocks — tokenized stocks on Base.`;
  const when = new Date(gift.createdAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const status = gift.status === "confirmed" ? "confirmed onchain" : gift.status === "failed" ? "failed" : "submitted";

  return (
    <div className="flex flex-col gap-6 max-w-[720px]">
      <PageTitle
        index="Gift"
        title={
          <span className="inline-flex items-center gap-3">
            {asset && <AssetLogo src={asset.logoURI} symbol={asset.symbol} size={40} />}
            {amount}
          </span>
        }
        lead={
          <>
            {senderName} sent {asset ? `${asset.name} as a Coinbase Tokenized Stock on Base` : "a tokenized stock"} to {recipientName} · {when}
          </>
        }
        action={<ShareButton path={`/gifts/${gift.id}`} text={shareText} title="Share this gift" size="md" />}
      />

      <Module>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] items-center gap-4 p-4 md:p-5">
          <Party p={receipt.sender} label="From" />
          <span className="hidden md:inline-flex items-center justify-center h-9 w-9 rounded-full border border-line text-primary" aria-hidden>
            <ArrowRight size={16} strokeWidth={2} />
          </span>
          <Party p={receipt.recipient} label="To" />
        </div>
        {gift.message && (
          <blockquote className="mx-4 md:mx-5 mb-4 border-l-2 border-primary pl-3 text-[15px] text-ink leading-snug">
            “{gift.message}”
          </blockquote>
        )}
        <div className="border-t border-line px-4 md:px-5 py-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] font-mono text-ink-muted">
          <span className="inline-flex items-center gap-1.5">
            <Gift size={12} strokeWidth={2} className="text-primary" /> {gift.kind === "buy-for-recipient" ? "bought and delivered directly" : "sent from the sender's wallet"}
          </span>
          <Badge tone={gift.status === "confirmed" ? "positive" : gift.status === "failed" ? "danger" : "warning"}>{status}</Badge>
          {gift.txHash && <TxLink hash={gift.txHash}>view transaction</TxLink>}
          <span>network: Base</span>
        </div>
      </Module>

      <div className="flex flex-wrap gap-2">
        {role === "recipient" && (
          <LinkButton href="/portfolio" variant="primary" size="lg">
            See it in your portfolio <ArrowUpRight size={16} strokeWidth={1.75} />
          </LinkButton>
        )}
        {asset && (
          <LinkButton href={`/stocks/${asset.address}?trade=buy`} variant={role === "recipient" ? "secondary" : "primary"} size="lg">
            {role === "visitor" ? `Buy or gift ${asset.underlying}` : `Buy more ${asset.underlying}`} <ArrowUpRight size={16} strokeWidth={1.75} />
          </LinkButton>
        )}
        <LinkButton href="/how-it-works" size="lg">
          How tokenized stocks work
        </LinkButton>
      </div>

      <p className="text-[13px] text-ink-secondary">
        The tokens sit in the recipient&apos;s own wallet, not with BStocks. Anyone can verify the transfer on Base; the message above is stored offchain by BStocks and shown only on this page.
      </p>
    </div>
  );
}

function Party({ p, label }: { p: GiftParty; label: string }) {
  const name = giftPartyLabel(p);
  const member = !!(p.basename || p.displayName);
  const profileHref = `/u/${p.address}`;
  return (
    <div className="flex items-center gap-3 min-w-0">
      <Avatar src={p.avatar} seed={p.address} label={name} size={44} />
      <span className="min-w-0">
        <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{label}</span>
        <span className="flex items-center gap-1.5 min-w-0">
          <Link href={profileHref} className="text-[15px] font-medium truncate hover:underline">
            {name}
          </Link>
          {member && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-primary shrink-0" title="BStocks member">
              <BadgeCheck size={12} strokeWidth={2} /> member
            </span>
          )}
        </span>
        <span className="block font-mono text-[11px] text-ink-secondary truncate">
          {shortenAddress(p.address, 6)}
          {p.basename && name !== p.basename ? ` · ${p.basename}` : ""}
        </span>
      </span>
    </div>
  );
}
