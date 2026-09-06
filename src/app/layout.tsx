import type { Metadata, Viewport } from "next";
import { DM_Sans, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { AppShell } from "@/components/layout/AppShell";
import { appMeta } from "@/lib/miniapp";

const body = DM_Sans({ subsets: ["latin"], variable: "--font-body", weight: ["400", "500", "600"], display: "swap" });
const display = Space_Grotesk({ subsets: ["latin"], variable: "--font-display", weight: ["500", "700"], display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "500"], display: "swap" });

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://basestocks.finance").replace(/\/$/, "");

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: { default: "BaseStocks — Stocks, built for onchain", template: "%s · BaseStocks" },
  description: "Trade tokenized stocks, build personalized portfolios, and put supported assets to work on Base.",
  applicationName: "BaseStocks",
  appleWebApp: { capable: true, title: "BaseStocks", statusBarStyle: "default" },
  openGraph: {
    type: "website",
    siteName: "BaseStocks",
    url: "/",
    locale: "en_US",
    title: "BaseStocks — Stocks, built for onchain",
    description: "Trade tokenized stocks, build personalized portfolios, and put supported assets to work on Base.",
  },
  twitter: { card: "summary_large_image", site: "@BaseOnStocks", creator: "@BaseOnStocks" },
  robots: { index: true, follow: true },
  // Icons come from the app/ file conventions (favicon.ico, icon.svg, apple-icon.tsx), which
  // override anything listed here: the blue tile with the white ascending blocks.
  other: appMeta(),
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0b0d" },
  ],
};

/** Structured data for link previews and search: the site and the org behind it. */
const jsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", name: "BaseStocks", url: APP_URL, description: "Trade Coinbase Tokenized Stocks, build personalized portfolios, and put supported assets to work on Base." },
    { "@type": "Organization", name: "BaseStocks", url: APP_URL, logo: `${APP_URL}/brand/icon-1024.png`, sameAs: ["https://x.com/BaseOnStocks"] },
  ],
});

const themeScript = `(function(){try{var t=localStorage.getItem('bstocks:theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}var m=localStorage.getItem('bstocks:motion');document.documentElement.setAttribute('data-motion',(m==='off'||m==='system')?m:'on');}catch(e){document.documentElement.setAttribute('data-motion','on');}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${body.variable} ${display.variable} ${mono.variable} h-full`}>
      <head>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col bg-canvas text-ink">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
