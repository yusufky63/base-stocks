"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy, Share2, Smartphone } from "lucide-react";
import { Sheet } from "@/components/ui/Sheet";
import { Button, cx } from "@/components/ui/primitives";
import { publicEnv } from "@/config/env";
import { useMiniApp } from "@/components/layout/MiniAppProvider";
import { composeCast } from "@/lib/miniapp-actions";
import { XMark } from "@/components/brand/Logo";

interface ShareProps {
  /** Path on this site (e.g. /stocks/0x…). */
  path: string;
  text: string;
}

/**
 * Outside the Base app there is no public compose intent to link to, so the post is copied and
 * base.app is opened for it to be pasted. Inside the app the host composes it properly — see
 * `composeCast` below, which is why this is only the fallback.
 */
const BASE_APP_URL = "https://base.app";

/**
 * Share actions as a plain block: link preview with copy, then Base app / system share, X and
 * copy-post. Used inline (e.g. after a confirmed trade) and inside ShareSheet — no nested dialogs.
 */
/** One share destination. A channel is recognised by its colour before its label, so each tile keeps its own. */
function ShareTile({
  label,
  icon,
  tone,
  compact,
  href,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  tone: "x" | "base" | "neutral" | "done";
  compact?: boolean;
  href?: string;
  onClick?: () => void;
}) {
  const toneClass = {
    // X is black on white and white on black — the same inversion `ink` already makes for the theme.
    x: "bg-ink text-canvas border-ink hover:opacity-90",
    base: "bg-primary-fill text-primary-contrast border-primary-strong hover:brightness-[1.08]",
    neutral: "bg-canvas text-ink border-line-strong hover:bg-surface",
    done: "bg-positive-soft text-positive-fg border-positive",
  }[tone];
  const shape = compact
    ? "h-11 flex-row gap-2 text-[13px]"
    : "h-[76px] flex-col gap-1.5 text-[13px]";
  const inner = (
    <>
      {icon}
      <span className="font-medium leading-none">{label}</span>
    </>
  );
  const className = cx(
    "inline-flex items-center justify-center rounded-[6px] border border-b-[3px] font-medium transition-fast active:border-b active:translate-y-[2px] outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
    toneClass,
    shape,
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" onClick={onClick} className={className}>
      {inner}
    </a>
  ) : (
    <button type="button" onClick={onClick} className={className}>
      {inner}
    </button>
  );
}

/**
 * Share actions as a plain block: a preview of the post, then one tile per destination.
 *
 * `compact` drops the preview and shortens the tiles, for places that already have their own
 * primary action — a claim confirmation offers "View your portfolio" first, and a second
 * full-width primary underneath would fight it.
 */
export function ShareActions({ path, text, className, compact }: ShareProps & { className?: string; compact?: boolean }) {
  const [copied, setCopied] = useState<"link" | "post" | null>(null);
  const [casting, setCasting] = useState(false);
  const { isMiniApp } = useMiniApp();
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
      /* clipboard blocked: the URL stays visible above */
    }
  };
  // Inside the Base app the link does not get copied anywhere: it goes straight into a composer
  // with the mini app card already attached. Falling back to the clipboard if the host declines.
  const cast = async () => {
    setCasting(true);
    const composed = await composeCast(text, url);
    setCasting(false);
    if (!composed) await copy("post");
  };
  const nativeShare = async () => {
    try {
      await navigator.share({ title: "BaseStocks", text, url });
    } catch {
      /* cancelled */
    }
  };

  return (
    <div className={cx("flex flex-col gap-3", className)}>
      {!compact && (
        <div className="rounded-[8px] border border-line bg-surface overflow-hidden">
          <div className="flex items-center gap-2 px-3 pt-2.5">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-positive" />
            <span className="eyebrow">Your post</span>
          </div>
          <p className="px-3 pt-1.5 text-[14px] leading-snug">{text}</p>
          <div className="mt-2.5 flex items-center gap-2 border-t border-line bg-canvas px-3 py-2 font-mono text-[11px] text-ink-muted">
            <span className="truncate">{url.replace(/^https?:\/\//, "")}</span>
            <button type="button" onClick={() => void copy("link")} aria-label="Copy link" className={cx("ml-auto shrink-0 inline-flex items-center gap-1 transition-fast", copied === "link" ? "text-positive-fg" : "text-primary hover:underline")}>
              {copied === "link" ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={2} />}
              {copied === "link" ? "copied" : "copy"}
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        <ShareTile compact={compact} tone="x" href={x} label="Post on X" icon={<XMark size={compact ? 14 : 18} />} />
        {isMiniApp ? (
          <ShareTile compact={compact} tone="base" onClick={() => void cast()} label={casting ? "Opening…" : "Cast"} icon={<Share2 size={compact ? 14 : 18} strokeWidth={1.75} />} />
        ) : (
          <ShareTile compact={compact} tone="base" href={BASE_APP_URL} onClick={() => void copy("post")} label="Base app" icon={<Smartphone size={compact ? 14 : 18} strokeWidth={1.75} />} />
        )}
        <ShareTile
          compact={compact}
          tone={copied === "post" ? "done" : "neutral"}
          onClick={() => void copy("post")}
          label={copied === "post" ? "Copied" : "Copy post"}
          icon={copied === "post" ? <Check size={compact ? 14 : 18} strokeWidth={2} /> : <Copy size={compact ? 14 : 18} strokeWidth={1.75} />}
        />
      </div>

      {!compact && canNativeShare && (
        <button type="button" onClick={() => void nativeShare()} className="self-center text-[13px] text-ink-secondary hover:text-primary transition-fast">
          More apps…
        </button>
      )}
      {!compact && !isMiniApp && <p className="text-[12px] text-ink-muted">The Base app has no compose link, so &ldquo;Base app&rdquo; copies the post and opens it for you to paste.</p>}
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
