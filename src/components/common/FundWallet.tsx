"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Building2, Check, ChevronDown, Copy, CreditCard, ExternalLink, Fuel, Globe, QrCode, Wallet, type LucideIcon } from "lucide-react";
import { useAccount } from "wagmi";
import QRCode from "qrcode";
import { hasReown } from "@/config/wagmi";
import { useConfigFlags } from "@/hooks/queries";
import { useAuth } from "@/hooks/useAuth";
import { apiPost, ApiError } from "@/lib/client-api";
import { getAppKit } from "@/config/appkit";
import { USDC_ADDRESS } from "@/config/chain";
import { shortenAddress } from "@/lib/format";
import { cx } from "@/components/ui/primitives";

interface Props {
  compact?: boolean;
  className?: string;
  /** Render the header as a disclosure the reader can close again, rather than a fixed panel. */
  collapsible?: boolean;
  /** Only meaningful with `collapsible`: whether it starts open. */
  defaultOpen?: boolean;
  /** Trade panel only: switch the payment token to ETH that is already on Base. */
  onPayWithEth?: () => void;
  /** Whether the wallet holds ETH on Base (makes the ETH tile the suggested path). */
  ethAvailable?: boolean;
}

interface Tile {
  id: string;
  icon: LucideIcon;
  title: string;
  body: string;
  href?: string;
  onClick?: () => void;
  highlight?: boolean;
  active?: boolean;
}

/**
 * Funding paths, in the order that costs the user the least (Base docs: fund users / accept payments):
 * ETH already on Base; withdraw from Coinbase to this wallet (no Onramp integration, by decision);
 * the wallet's own onramp providers; LI.FI from any chain; or a plain receive (address + QR) from
 * any wallet or exchange. Base Account can also draw from a Coinbase balance at confirmation.
 */
export function FundWallet({ compact = false, className, onPayWithEth, ethAvailable = false, collapsible = false, defaultOpen = true }: Props) {
  const { address, connector } = useAccount();
  const { ensureSignedIn } = useAuth();
  const flags = useConfigFlags();
  const [receive, setReceive] = useState(false);
  const [open, setOpen] = useState(!collapsible || defaultOpen);
  const [onrampBusy, setOnrampBusy] = useState(false);
  const [onrampError, setOnrampError] = useState<string | null>(null);
  if (!address) return null;
  const isBaseAccount = connector?.id === "baseAccount";
  const openAppKitOnramp = () => {
    const kit = hasReown ? getAppKit() : null;
    if (kit) void kit.open({ view: "OnRampProviders" });
  };

  /**
   * Coinbase Onramp. The session token is minted server-side for the signed-in wallet and expires
   * in five minutes, so the window is opened on the click that asked for it rather than from a
   * link prepared earlier.
   */
  const openCoinbaseOnramp = async () => {
    setOnrampBusy(true);
    setOnrampError(null);
    try {
      await ensureSignedIn();
      const { url } = await apiPost<{ url: string }>("/api/onramp/session", {});
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setOnrampError(err instanceof ApiError ? err.message : "Could not start a top-up right now. Try again.");
    } finally {
      setOnrampBusy(false);
    }
  };

  const tiles: Tile[] = [];
  if (onPayWithEth) tiles.push({ id: "eth", icon: Fuel, title: ethAvailable ? "Pay with ETH instead" : "Pay with ETH", body: ethAvailable ? "You already hold ETH on Base. No bridge, no top-up." : "ETH already on Base needs no bridge.", onClick: onPayWithEth, highlight: ethAvailable });
  tiles.push({ id: "coinbase", icon: Building2, title: "From Coinbase", body: "Withdraw USDC on the Base network to this wallet.", onClick: () => setReceive(true), active: receive });
  if (flags.data?.onramp) {
    tiles.push({
      id: "onramp",
      icon: CreditCard,
      title: onrampBusy ? "Opening Coinbase…" : "Card or Apple Pay",
      body: "Buy USDC with Coinbase. It lands in this wallet on Base.",
      onClick: () => void openCoinbaseOnramp(),
    });
  } else if (hasReown) {
    tiles.push({ id: "card", icon: CreditCard, title: "Card or bank", body: "Onramp providers inside your wallet.", onClick: openAppKitOnramp });
  }
  tiles.push({ id: "lifi", icon: Globe, title: "From another chain", body: "Bridge or swap from 20+ chains with LI.FI.", href: lifiUrlFor(address) });
  tiles.push({ id: "receive", icon: QrCode, title: "Receive", body: "Address and QR for any wallet or exchange.", onClick: () => setReceive((v) => !v), active: receive });

  const header = (
    <>
      <span className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-[6px] bg-primary-soft text-primary">
        <Wallet size={15} strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-[13px] font-medium leading-tight">{compact ? "Add USDC to trade" : "Add funds"}</span>
        <span className="block text-[12px] text-ink-secondary leading-snug mt-0.5">
          {isBaseAccount ? "Base Account can pay from your Coinbase balance when you confirm a trade, so a top-up is optional." : "Trades settle in USDC on Base. Pick the path that already holds your money."}
        </span>
      </span>
      {collapsible && <ChevronDown size={16} strokeWidth={1.75} className={cx("shrink-0 mt-0.5 text-ink-muted transition-transform", open && "rotate-180")} />}
    </>
  );

  return (
    <div className={cx("border border-line rounded-[8px] overflow-hidden bg-surface", className)}>
      {collapsible ? (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full px-3 py-2.5 flex items-start gap-2.5 hover:bg-surface-muted/60 transition-fast">
          {header}
        </button>
      ) : (
        <div className="px-3 py-2.5 flex items-start gap-2.5">{header}</div>
      )}
      {open && (
        <>
      <div className={cx("grid gap-px bg-line border-t border-line", compact ? "grid-cols-2" : "grid-cols-2 md:grid-cols-3")}>
        {tiles.map((t, i) => (
          <FundTile key={t.id} tile={t} compact={compact} className={i === tiles.length - 1 ? lastTileSpan(tiles.length, compact) : undefined} />
        ))}
      </div>
      {onrampError && <p className="px-3 py-2 border-t border-line text-[12px] text-danger-fg">{onrampError}</p>}
      {receive && <ReceivePanel address={address} onClose={() => setReceive(false)} />}
      {isBaseAccount && (
        <p className="px-3 py-2 border-t border-line text-[11px] text-ink-muted flex items-center gap-1.5">
          <Check size={12} strokeWidth={2} className="text-positive-fg" /> Base Account connected: gas is sponsored and a Coinbase balance can fund the trade at confirmation.
        </p>
      )}
        </>
      )}
    </div>
  );
}

/** Let the last tile fill the remainder of its row (2 columns on small screens, 3 on md+ when not compact). */
function lastTileSpan(n: number, compact: boolean): string {
  const sm = n % 2 === 1 ? "col-span-2" : "col-span-1";
  if (compact) return sm;
  const md = n % 3 === 1 ? "md:col-span-3" : n % 3 === 2 ? "md:col-span-2" : "md:col-span-1";
  return `${sm} ${md}`;
}

function FundTile({ tile, compact, className: extra }: { tile: Tile; compact: boolean; className?: string }) {
  const Icon = tile.icon;
  const inner = (
    <>
      <span className="flex items-center justify-between gap-2">
        <Icon size={15} strokeWidth={1.75} className={tile.highlight ? "text-primary" : "text-ink-secondary"} />
        {tile.href ? <ExternalLink size={11} strokeWidth={1.75} className="text-ink-muted" /> : <ArrowUpRight size={12} strokeWidth={1.75} className="text-ink-muted" />}
      </span>
      <span className={cx("block text-[13px] font-medium leading-tight", tile.highlight && "text-primary")}>{tile.title}</span>
      {!compact && <span className="block text-[11px] text-ink-secondary leading-snug">{tile.body}</span>}
    </>
  );
  const className = cx(
    "flex flex-col gap-1.5 p-3 text-left bg-canvas hover:bg-surface transition-fast min-h-[64px]",
    extra,
    tile.active && "bg-primary-soft",
    tile.highlight && "bg-primary-soft ring-1 ring-inset ring-primary/25",
  );
  if (tile.href) {
    return (
      <a href={tile.href} target="_blank" rel="noreferrer noopener" className={className} title={tile.body}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" onClick={tile.onClick} aria-pressed={tile.active} className={className} title={tile.body}>
      {inner}
    </button>
  );
}

function ReceivePanel({ address, onClose }: { address: string; onClose: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(address, { margin: 1, width: 176, errorCorrectionLevel: "M", color: { dark: "#0a0b0d", light: "#ffffff" } })
      .then((url) => alive && setQr(url))
      .catch(() => alive && setQr(null));
    return () => {
      alive = false;
    };
  }, [address]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked: the address stays visible */
    }
  };
  return (
    <div className="border-t border-line p-3 flex gap-3 items-start">
      {qr ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr} alt="Wallet address QR code" width={88} height={88} className="rounded-[6px] bg-white shrink-0" />
      ) : (
        <span className="h-[88px] w-[88px] rounded-[6px] bg-surface-muted shrink-0" aria-hidden />
      )}
      <div className="min-w-0 flex-1 flex flex-col gap-1.5">
        <div className="text-[12px] font-medium">Send USDC on the Base network to</div>
        <div className="flex items-center gap-2">
          <code className="font-mono text-[12px] text-ink break-all">{address}</code>
          <button type="button" onClick={copy} aria-label="Copy address" className="shrink-0 h-8 w-8 inline-flex items-center justify-center rounded-[6px] border border-line text-ink-muted hover:text-ink">
            {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={2} />}
          </button>
        </div>
        <p className="text-[11px] text-ink-muted">
          {shortenAddress(address, 6)} · Choose <span className="text-ink">Base</span> as the network when withdrawing from Coinbase or another exchange. Funds sent on other networks do not arrive here.
        </p>
        <button type="button" onClick={onClose} className="self-start text-[12px] text-primary font-medium hover:underline">
          Done
        </button>
      </div>
    </div>
  );
}

/** LI.FI's hosted app with the destination prefilled: USDC on Base, sent to the connected wallet. */
function lifiUrlFor(address: string): string {
  const p = new URLSearchParams({ toChain: "8453", toToken: USDC_ADDRESS, toAddress: address, fromChain: "1", fromToken: "0x0000000000000000000000000000000000000000" });
  return `https://jumper.exchange/?${p.toString()}`;
}
