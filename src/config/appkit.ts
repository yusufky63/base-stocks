"use client";

import { base as appkitBase } from "@reown/appkit/networks";
import { APP_NAME, hasReown, networks, projectId, wagmiAdapter } from "./wagmi";
import { publicEnv } from "./env";
import { BASE_ACCOUNT_WALLET_ID } from "./chain";

type AppKitModule = typeof import("@reown/appkit/react");
type AppKitInstance = ReturnType<AppKitModule["createAppKit"]>;
let instance: AppKitInstance | null = null;
let loading: Promise<AppKitInstance | null> | null = null;

/**
 * The wallet modal, created on the client and loaded only when it is about to be needed.
 *
 * `@reown/appkit/react` and the modal UI behind it are the heaviest thing in the client bundle,
 * and most visitors never open the modal — they read prices. So the module is imported here on
 * demand: the providers warm it once the page is idle, and a "Connect" tap before that awaits
 * this same promise. Base Account is featured first; every other wallet remains available
 * (docs.base.org/sdks/base-account/framework-integrations/reown).
 */
export function ensureAppKit(themeMode: "light" | "dark" = "light"): Promise<AppKitInstance | null> {
  if (!hasReown || !wagmiAdapter) return Promise.resolve(null);
  if (typeof window === "undefined") return Promise.resolve(null);
  if (instance) return Promise.resolve(instance);
  if (loading) return loading;
  loading = import("@reown/appkit/react")
    .then(({ createAppKit }) => {
      instance ??= createAppKit({
        adapters: [wagmiAdapter!],
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
    })
    .catch(() => {
      loading = null;
      return null;
    });
  return loading;
}

/** The modal, when it has been created; null until then (see `ensureAppKit`). */
export function getAppKit(): AppKitInstance | null {
  return instance;
}
