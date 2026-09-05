"use client";

import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/config/wagmi";
import { ensureAppKit, getAppKit } from "@/config/appkit";
import { ThemeProvider, useTheme } from "@/components/layout/ThemeProvider";
import { MiniAppProvider } from "@/components/layout/MiniAppProvider";

/**
 * Loads the wallet modal once the page is idle, so the first tap on "Connect" is answered at
 * once — and never before, so a visitor who only reads prices never downloads it. The modal's
 * UI is a second bundle AppKit imports on the first open(); that is warmed too.
 */
function AppKitBoot() {
  const { resolved } = useTheme();
  useEffect(() => {
    let cancelled = false;
    const warm = () => {
      void ensureAppKit(resolved).then((kit) => {
        if (cancelled || !kit) return;
        kit.setThemeMode(resolved);
        void (kit as unknown as { injectModalUi?: () => Promise<void> }).injectModalUi?.().catch(() => undefined);
      });
    };
    const existing = getAppKit();
    if (existing) {
      existing.setThemeMode(resolved);
      return;
    }
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(warm, { timeout: 4_000 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(id);
      };
    }
    const t = setTimeout(warm, 1_500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [resolved]);
  return null;
}

/**
 * Wagmi hydrates the connection on the client after mount (`ssr: true`), so the server renders
 * every page as "not connected" and needs no cookie for it. That is what lets pages be cached
 * and served from the edge instead of rendered per request; the price is a moment of
 * "Connect" on a full page load for a wallet that is connected, before it reconnects.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AppKitBoot />
          <MiniAppProvider>{children}</MiniAppProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
