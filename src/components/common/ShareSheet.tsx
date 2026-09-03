"use client";

import { useState } from "react";
import { Check, Copy, Share2, Smartphone } from "lucide-react";
import { Sheet } from "@/components/ui/Sheet";
import { Button, cx } from "@/components/ui/primitives";
import { publicEnv } from "@/config/env";

/** X (Twitter) mark at button-icon size. */
function XIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

interface ShareProps {
  /** Path on this site (e.g. /stocks/0x…). */
  path: string;
  text: string;
}

/** The Base app has no public compose intent; on desktop we copy the post and open base.app so it can be pasted. */
const BASE_APP_URL = "https://base.app";

/**
 * Share actions as a plain block: link preview with copy, then Base app / system share, X and
 * copy-post. Used inline (e.g. after a confirmed trade) and inside ShareSheet — no nested dialogs.
 */
export function ShareActions({ path, text, className }: ShareProps & { className?: string }) {
  const [copied, setCopied] = useState<"link" | "post" | null>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : publicEnv.appUrl;
  const url = `${origin}${path}`;
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
    <div className={cx("flex flex-col gap-3", className)}>
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
          className="inline-flex items-center justify-center gap-2 h-12 rounded-[6px] bg-primary text-primary-contrast border border-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.16)] font-medium text-[15px] whitespace-nowrap hover:bg-primary-strong active:translate-y-px active:shadow-none transition-fast outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <Smartphone size={16} strokeWidth={1.75} /> {copied === "post" ? "Copied · opening Base app" : "Copy post & open Base app"}
        </a>
      )}
      <div className="grid grid-cols-2 gap-2">
        <a href={x} target="_blank" rel="noreferrer noopener" className="inline-flex items-center justify-center gap-2 h-11 rounded-[6px] border border-line bg-canvas text-ink font-medium text-[14px] whitespace-nowrap hover:bg-surface hover:border-line-strong active:translate-y-px transition-fast outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
          <XIcon /> Post on X
        </a>
        <Button variant="secondary" onClick={() => copy("post")} className="whitespace-nowrap">
          {copied === "post" ? <Check size={14} strokeWidth={1.75} /> : <Copy size={14} strokeWidth={1.75} />} {copied === "post" ? "Copied" : "Copy post"}
        </Button>
      </div>
    </div>
  );
}

interface ButtonProps extends ShareProps {
  title?: string;
  size?: "sm" | "md";
  className?: string;
  label?: string;
  /** Square icon button (matches the watchlist star). */
  iconOnly?: boolean;
}

/** Share a stock, basket, profile or gift: opens a small sheet with the share actions. */
export function ShareButton({ path, text, title = "Share", size = "sm", className, label = "Share", iconOnly = false }: ButtonProps) {
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

export function ShareSheet({ open, onClose, path, text, title = "Share" }: ShareProps & { open: boolean; onClose: () => void; title?: string }) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <ShareActions path={path} text={text} />
    </Sheet>
  );
}
