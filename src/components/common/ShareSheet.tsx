"use client";

import { useState } from "react";
import { Check, Copy, Share2, Smartphone, ExternalLink } from "lucide-react";
import { useAccount } from "wagmi";
import { Sheet } from "@/components/ui/Sheet";
import { Button, cx } from "@/components/ui/primitives";
import { publicEnv } from "@/config/env";
import { shortenAddress } from "@/lib/format";

interface Props {
  /** Path on this site (e.g. /stocks/0x…). The wallet's referral tag is appended when connected. */
  path: string;
  text: string;
  title?: string;
  size?: "sm" | "md";
  className?: string;
  label?: string;
  /** Square icon button (matches the watchlist star). */
  iconOnly?: boolean;
}

/** Share a stock, basket, profile or trade: Base app / other apps (Web Share), X, or copy link with the referral tag. */
export function ShareButton({ path, text, title = "Share", size = "sm", className, label = "Share", iconOnly = false }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {iconOnly ? (
        <button type="button" aria-label={title} onClick={() => setOpen(true)} className={cx("h-9 w-9 inline-flex items-center justify-center rounded-[6px] border border-line text-ink-muted hover:border-line-strong hover:text-ink transition-fast", className)}>
          <Share2 size={16} strokeWidth={1.75} />
        </button>
      ) : (
        <Button variant="secondary" size={size} className={className} onClick={() => setOpen(true)}>
          <Share2 size={14} strokeWidth={1.75} /> {label}
        </Button>
      )}
      {open && <ShareSheet open={open} onClose={() => setOpen(false)} path={path} text={text} title={title} />}
    </>
  );
}

/** The Base app has no public compose intent; on desktop we copy the post and open base.app so it can be pasted. */
const BASE_APP_URL = "https://base.app";

export function ShareSheet({ open, onClose, path, text, title = "Share" }: { open: boolean; onClose: () => void; path: string; text: string; title?: string }) {
  const { address } = useAccount();
  const [copied, setCopied] = useState<"link" | "post" | null>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : publicEnv.appUrl;
  const url = `${origin}${path}${address ? `${path.includes("?") ? "&" : "?"}ref=${address}` : ""}`;
  const message = `${text} ${url}`;
  const x = `https://x.com/intent/post?text=${encodeURIComponent(message)}`;
  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const copy = async (what: "link" | "post") => {
    try {
      await navigator.clipboard.writeText(what === "link" ? url : message);
      setCopied(what);
      setTimeout(() => setCopied(null), 1400);
    } catch {
      /* clipboard blocked: the URL stays visible below */
    }
  };
  const nativeShare = async () => {
    try {
      await navigator.share({ title: "BStocks", text, url });
    } catch {
      /* cancelled */
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="flex flex-col gap-4">
        {/* Preview of what gets posted */}
        <div className="border border-line rounded-[8px] p-3 flex flex-col gap-2 bg-surface">
          <p className="text-[14px] leading-snug">{text}</p>
          <div className="flex items-center gap-2 font-mono text-[11px] text-ink-muted">
            <span className="truncate">{url.replace(/^https?:\/\//, "")}</span>
            <button type="button" onClick={() => copy("link")} aria-label="Copy link" className="shrink-0 inline-flex items-center gap-1 text-primary hover:underline">
              {copied === "link" ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={2} />}
              {copied === "link" ? "copied" : "copy"}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {canNativeShare ? (
            <Button variant="primary" size="lg" full onClick={nativeShare}>
              <Smartphone size={16} strokeWidth={1.75} /> Share to Base app or other apps
            </Button>
          ) : (
            <a
              href={BASE_APP_URL}
              target="_blank"
              rel="noreferrer noopener"
              onClick={() => void copy("post")}
              className={cx("inline-flex items-center justify-center gap-2 h-12 rounded-[6px] bg-primary text-primary-contrast font-medium text-[15px] whitespace-nowrap")}
            >
              <Smartphone size={16} strokeWidth={1.75} /> {copied === "post" ? "Copied · opening Base app" : "Copy post & open Base app"} <ExternalLink size={14} strokeWidth={1.75} />
            </a>
          )}
          <div className="grid grid-cols-2 gap-2">
            <a href={x} target="_blank" rel="noreferrer noopener" className={cx("inline-flex items-center justify-center gap-2 h-11 rounded-[6px] border border-line-strong hover:border-line-strong font-medium text-[14px] whitespace-nowrap")}>
              Post on X <ExternalLink size={13} strokeWidth={1.75} />
            </a>
            <Button variant="secondary" onClick={() => copy("post")} className="whitespace-nowrap">
              {copied === "post" ? <Check size={14} strokeWidth={1.75} /> : <Copy size={14} strokeWidth={1.75} />} {copied === "post" ? "Copied" : "Copy post"}
            </Button>
          </div>
        </div>

        <p className="text-[12px] text-ink-muted">
          {address ? `Your referral tag (${shortenAddress(address)}) is in the link; wallets that sign in through it count toward your Ambassador badge. ` : "Connect a wallet to add your referral tag to the link. "}
          {canNativeShare ? "The first button opens your device's share sheet, where the Base app appears when installed." : "The post is copied to your clipboard and the Base app opens in a new tab; paste it into a new post."}
        </p>
      </div>
    </Sheet>
  );
}
