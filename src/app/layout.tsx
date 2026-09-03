import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { DM_Sans, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { AppShell } from "@/components/layout/AppShell";

const body = DM_Sans({ subsets: ["latin"], variable: "--font-body", weight: ["400", "500", "600"], display: "swap" });
const display = Space_Grotesk({ subsets: ["latin"], variable: "--font-display", weight: ["500", "700"], display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "500"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "BStocks — Stocks, built for onchain", template: "%s · BStocks" },
  description: "Trade tokenized stocks, build personalized portfolios, and put supported assets to work on Base.",
  applicationName: "BStocks",
  icons: { icon: "/icon.svg" },
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

const themeScript = `(function(){try{var t=localStorage.getItem('bstocks:theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}var m=localStorage.getItem('bstocks:motion');document.documentElement.setAttribute('data-motion',(m==='off'||m==='system')?m:'on');}catch(e){document.documentElement.setAttribute('data-motion','on');}})();`;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const cookies = (await headers()).get("cookie");
  return (
    <html lang="en" suppressHydrationWarning className={`${body.variable} ${display.variable} ${mono.variable} h-full`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col bg-canvas text-ink">
        <Providers cookies={cookies}>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
