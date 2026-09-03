"use client";

import { createAppKit } from "@reown/appkit/react";
import { base as appkitBase } from "@reown/appkit/networks";
import { APP_NAME, hasReown, networks, projectId, wagmiAdapter } from "./wagmi";
import { publicEnv } from "./env";
import { BASE_ACCOUNT_WALLET_ID } from "./chain";

type AppKitInstance = ReturnType<typeof createAppKit>;
let instance: AppKitInstance | null = null;

/**
 * Lazily create the AppKit modal on the client. Base Account is featured first; every other
 * wallet remains available (docs.base.org/sdks/base-account/framework-integrations/reown).
 */
export function ensureAppKit(themeMode: "light" | "dark" = "light"): AppKitInstance | null {
  if (!hasReown || !wagmiAdapter) return null;
  if (typeof window === "undefined") return null;
  if (instance) return instance;
  instance = createAppKit({
    adapters: [wagmiAdapter],
    projectId,
    networks,
    defaultNetwork: appkitBase,
    // Do not pop AppKit's own "Switch network" modal on page load when the wallet sits on another
    // chain (spec §19: nothing is requested on load). The header shows a "Switch to Base" button
    // instead, and every action re-checks the chain before it runs.
    allowUnsupportedChain: true,
    metadata: {
      name: APP_NAME,
      description: "Stocks, built for onchain. Trade tokenized stocks and build portfolios on Base.",
      url: publicEnv.appUrl,
      icons: [`${publicEnv.appUrl}/brand/icon-1024.png`],
    },
    themeMode,
    themeVariables: {
      "--w3m-accent": "#0370fd",
      "--w3m-border-radius-master": "2px",
      "--w3m-font-family": "Inter, system-ui, sans-serif",
    },
    features: {
      analytics: false,
      email: false,
      socials: false,
      swaps: false,
      // Card / bank onramp inside the wallet modal, for users who connect with no USDC.
      onramp: true,
      connectMethodsOrder: ["wallet"],
    },
    featuredWalletIds: [BASE_ACCOUNT_WALLET_ID],
    allWallets: "SHOW",
    enableWallets: true,
  });
  return instance;
}

export function getAppKit(): AppKitInstance | null {
  return instance;
}
