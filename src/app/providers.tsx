"use client";

import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, useAccount } from "wagmi";
import { couldBeMiniAppHost, hasReown, wagmiConfig } from "@/config/wagmi";
import { getAppKit, warmAppKit } from "@/config/appkit";
import { ThemeProvider, useTheme } from "@/components/layout/ThemeProvider";
import { MiniAppProvider } from "@/components/layout/MiniAppProvider";

/**
 * Loads the wallet modal on a sign of intent, never on idle: a visitor who only reads prices
 * should not download ~686 KB they will never open. Intent is any of
 *  - wagmi restoring a stored connection (the account chip opens this modal on click),
 *  - the first pointerdown anywhere on the page (the visitor is interacting, not just reading),
 *  - the pointer or focus reaching the Connect button (wired in ConnectButton).
 * Inside a mini app host the modal is never used at all, the host wallet connects on its own, so
 * nothing is loaded there. When the modal already exists this only keeps its theme in step.
 */
function AppKitBoot() {
  const { resolved } = useTheme();
  const { status } = useAccount();
  const restoring = status === "connected" || status === "reconnecting";

  useEffect(() => {
    if (!hasReown || couldBeMiniAppHost()) return;
    const existing = getAppKit();
    if (existing) {
      existing.setThemeMode(resolved);
      return;
    }
    if (restoring) {
      warmAppKit(resolved);
      return;
    }
    const onFirstPointer = () => warmAppKit(resolved);
    window.addEventListener("pointerdown", onFirstPointer, { once: true, passive: true, capture: true });
    return () => window.removeEventListener("pointerdown", onFirstPointer, { capture: true });
  }, [resolved, restoring]);
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
