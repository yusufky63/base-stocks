"use client";

import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, cookieToInitialState } from "wagmi";
import { wagmiConfig } from "@/config/wagmi";
import { ensureAppKit } from "@/config/appkit";
import { ThemeProvider, useTheme } from "@/components/layout/ThemeProvider";
import { MiniAppProvider } from "@/components/layout/MiniAppProvider";

function AppKitBoot() {
  const { resolved } = useTheme();
  useEffect(() => {
    const kit = ensureAppKit(resolved);
    kit?.setThemeMode(resolved);
  }, [resolved]);
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
