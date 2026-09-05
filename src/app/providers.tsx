"use client";

import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, cookieToInitialState } from "wagmi";
import { wagmiConfig } from "@/config/wagmi";
import { ensureAppKit, getAppKit } from "@/config/appkit";
import { ThemeProvider, useTheme } from "@/components/layout/ThemeProvider";
import { MiniAppProvider } from "@/components/layout/MiniAppProvider";

function AppKitBoot() {
  const { resolved } = useTheme();
  useEffect(() => {
    const kit = ensureAppKit(resolved);
    kit?.setThemeMode(resolved);
  }, [resolved]);
  // The modal's UI is a separate bundle AppKit imports on the first open(), which is why the first
  // tap on "Connect" used to look ignored for a few seconds. Load it once the page is idle instead.
  useEffect(() => {
    const kit = getAppKit();
    if (!kit) return;
    const warm = () => void (kit as unknown as { injectModalUi?: () => Promise<void> }).injectModalUi?.().catch(() => undefined);
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(warm, { timeout: 4_000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(warm, 1_500);
    return () => clearTimeout(t);
  }, []);
  return null;
}

export function Providers({ children, cookies }: { children: ReactNode; cookies: string | null }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );
  const initialState = cookieToInitialState(wagmiConfig, cookies ?? undefined);

  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AppKitBoot />
          <MiniAppProvider>{children}</MiniAppProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
