"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, LineChart, Layers, PieChart, Sprout, Moon, Sun, Newspaper, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { ConnectButton } from "./ConnectButton";
import { useTheme } from "./ThemeProvider";
import { cx } from "@/components/ui/primitives";
import { LegalNotice } from "@/components/common/display";
import { Wordmark } from "@/components/brand/Logo";
import { TopTicker } from "./TopTicker";

const X_URL = "https://x.com/BaseOnStocks";

/** X (Twitter) mark, drawn to match the outline icon set's 14px size. */
function XLogo() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** Mobile bar: five destinations. Strategies groups Build, Community and Automate as tabs. */
const NAV = [
  { href: "/", label: "Home", icon: Home },
  { href: "/markets", label: "Markets", icon: LineChart },
  { href: "/build", label: "Strategies", icon: Layers },
  { href: "/earn", label: "Earn", icon: Sprout },
  { href: "/portfolio", label: "Portfolio", icon: PieChart },
] as const;

/** Desktop header: the logo is Home, so Home is not repeated; News joins from lg up (it collides with the wallet chip on tablets). */
const DESKTOP_NAV = [...NAV.filter((n) => n.href !== "/").map((n) => ({ ...n, extra: false })), { href: "/news", label: "News", icon: Newspaper, extra: true }] as const;

const FOOTER_LINKS = [
  ["/markets", "Markets"],
  ["/build", "Strategies"],
  ["/earn", "Earn"],
  ["/portfolio", "Portfolio"],
  ["/news", "News"],
  ["/how-it-works", "How it works"],
  ["/how-it-works#faq", "FAQ"],
  ["/status", "Status"],
  ["/settings", "Settings"],
] as const;

function isActive(path: string, href: string): boolean {
  if (href === "/") return path === "/";
  if (href === "/markets") return path.startsWith("/markets") || path.startsWith("/stocks");
  if (href === "/build") return path.startsWith("/build") || path.startsWith("/community") || path.startsWith("/baskets") || path.startsWith("/automate") || path.startsWith("/u/");
  return path.startsWith(href);
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const showTicker = !path.startsWith("/admin");
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="sticky top-0 z-30">
        {showTicker && <TopTicker />}
        <header className="border-b border-line bg-canvas/95 backdrop-blur-[2px]">
          <div className="mx-auto flex h-14 max-w-[1320px] items-center justify-between gap-2 md:gap-3 px-4 md:px-6">
            <Link href="/" aria-label="BStocks home" className="inline-flex shrink-0">
              <Wordmark />
            </Link>
            <nav aria-label="Primary" className="hidden md:flex items-center gap-0 lg:gap-0.5 min-w-0">
              {DESKTOP_NAV.map((n) => {
                const active = isActive(path, n.href);
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "relative h-10 px-2 lg:px-3 items-center rounded-[6px] text-[13px] lg:text-[14px] font-medium transition-fast whitespace-nowrap",
                      n.extra ? "hidden lg:inline-flex" : "inline-flex",
                      "after:absolute after:left-2 after:right-2 lg:after:left-3 lg:after:right-3 after:bottom-1 after:h-[2px] after:bg-primary after:origin-left after:transition-transform after:duration-[180ms]",
                      active ? "text-primary after:scale-x-100" : "text-ink-secondary hover:text-ink after:scale-x-0 hover:after:scale-x-100",
                    )}
                  >
                    {n.label}
                  </Link>
                );
              })}
            </nav>
            <div className="flex items-center gap-1.5 shrink-0">
              <ThemeToggle />
              <Link
                href="/settings"
                aria-label="Settings"
                aria-current={path.startsWith("/settings") ? "page" : undefined}
                className={cx("h-9 w-9 inline-flex items-center justify-center rounded-[6px] border transition-fast", path.startsWith("/settings") ? "text-primary border-primary" : "text-ink-secondary hover:text-ink border-line hover:border-line-strong")}
              >
                <Settings size={16} strokeWidth={1.75} />
              </Link>
              <span aria-hidden className="hidden md:block w-px h-6 bg-line mx-1" />
              <ConnectButton size="sm" compact />
            </div>
          </div>
        </header>
      </div>

      <main className="flex-1 mx-auto w-full max-w-[1320px] px-4 md:px-6 py-5 md:py-8">{children}</main>

      {/* Compact footer: one horizontal band, legal text collapsed on mobile */}
      <footer className="border-t border-line bg-canvas pb-16 md:pb-0">
        <div className="mx-auto max-w-[1320px] px-4 md:px-6 py-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Wordmark size={18} />
            <span className="eyebrow">Built on Base</span>
            <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-4 gap-y-1 md:ml-auto">
              {FOOTER_LINKS.map(([href, label]) => (
                <Link key={href} href={href} className="text-[13px] text-ink-secondary hover:text-primary transition-fast">
                  {label}
                </Link>
              ))}
            </nav>
            <a href={X_URL} target="_blank" rel="noopener noreferrer" aria-label="BStocks on X" title="@BaseOnStocks on X" className="inline-flex items-center gap-1.5 text-[13px] text-ink-secondary hover:text-primary transition-fast">
              <XLogo />
              <span className="font-mono text-[12px]">@BaseOnStocks</span>
            </a>
          </div>
          <div className="hidden md:block text-[12px] text-ink-muted leading-relaxed">
            <LegalNotice compact />
          </div>
          <details className="md:hidden text-[12px] text-ink-muted">
            <summary className="cursor-pointer select-none font-mono uppercase tracking-[0.08em] text-[11px]">Availability &amp; legal</summary>
            <div className="mt-2">
              <LegalNotice compact />
            </div>
          </details>
        </div>
      </footer>

      <nav aria-label="Primary mobile" className="md:hidden fixed inset-x-0 bottom-0 z-30 border-t border-line bg-canvas [padding-bottom:env(safe-area-inset-bottom)]">
        <div className="grid grid-cols-5">
          {NAV.map((n) => {
            const Icon = n.icon;
            const active = isActive(path, n.href);
            return (
              <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined} className={cx("relative flex flex-col items-center justify-center gap-1 h-14 text-[10px] font-medium", active ? "text-primary" : "text-ink-secondary")}>
                {active && <span aria-hidden className="absolute top-0 left-1/2 -translate-x-1/2 w-7 h-[2px] bg-primary" />}
                <Icon size={19} strokeWidth={1.75} />
                {n.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

/** One click flips between light and dark (the "system" mode lives in Settings). */
export function ThemeToggle() {
  const { resolved, setPreference } = useTheme();
  const Icon = resolved === "dark" ? Sun : Moon;
  return (
    <button type="button" aria-label={resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={() => setPreference(resolved === "dark" ? "light" : "dark")} className="h-9 w-9 inline-flex items-center justify-center rounded-[6px] text-ink-secondary hover:text-ink border border-line hover:border-line-strong transition-fast">
      <Icon size={16} strokeWidth={1.75} />
    </button>
  );
}
