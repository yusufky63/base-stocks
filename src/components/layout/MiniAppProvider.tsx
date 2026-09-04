"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAccount, useConnect } from "wagmi";
import type { Context as MiniAppContextTypes } from "@farcaster/miniapp-sdk";
import { BASE_CHAIN_ID } from "@/config/chain";
import { MINI_APP_CONNECTOR_ID, couldBeMiniAppHost } from "@/config/wagmi";
import { externalTarget, miniAppSdk, openExternal } from "@/lib/miniapp-actions";

/**
 * Everything the app needs to know about running inside the Base app rather than a browser tab.
 *
 * Two jobs, and the first one is not optional: a mini app host shows a splash screen and keeps it
 * up until the page calls `ready()`. Miss that call and the app never appears — no error, no blank
 * page, just a spinner forever. So `ready()` is fired from an effect as soon as the shell has
 * mounted, inside a try/catch, because a throw on the way there would strand every visitor.
 *
 * The second is the wallet. In the host the user is already signed in to an account that is
 * already on Base, and putting a "Connect wallet" modal in front of them there is asking a question
 * that has already been answered. So the host connector is connected on arrival. That is a
 * connection, not a signature — nothing is signed on load here either (spec §19).
 */
export type MiniAppStatus = "unknown" | "outside" | "inside";

interface MiniAppState {
  status: MiniAppStatus;
  /** True only once the host has answered; `false` while still unknown. */
  isMiniApp: boolean;
  context: MiniAppContextTypes.MiniAppContext | null;
}

const MiniAppCtx = createContext<MiniAppState>({ status: "unknown", isMiniApp: false, context: null });

export function useMiniApp(): MiniAppState {
  return useContext(MiniAppCtx);
}

/** The host owns the notch and its own chrome; it reports the insets rather than the viewport doing it. */
function applySafeArea(insets: MiniAppContextTypes.SafeAreaInsets | undefined) {
  if (!insets) return;
  const root = document.documentElement;
  root.style.setProperty("--miniapp-safe-top", `${insets.top}px`);
  root.style.setProperty("--miniapp-safe-bottom", `${insets.bottom}px`);
  root.style.setProperty("--miniapp-safe-left", `${insets.left}px`);
  root.style.setProperty("--miniapp-safe-right", `${insets.right}px`);
}

export function MiniAppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MiniAppState>({ status: "unknown", isMiniApp: false, context: null });

  useEffect(() => {
    let cancelled = false;
    const outside = () => {
      if (!cancelled) setState({ status: "outside", isMiniApp: false, context: null });
    };
    void (async () => {
      // Outside an iframe or a WebView there is provably no host, so nothing is asked of one.
      // `isInMiniApp()` would reach the same answer, but only after a second of waiting for a
      // reply that cannot come, and that second sits in front of every ordinary page load.
      if (!couldBeMiniAppHost()) return outside();
      try {
        const sdk = await miniAppSdk();
        const inside = await sdk.isInMiniApp();
        if (cancelled) return;
        if (!inside) return outside();
        const context = await sdk.context.catch(() => null);
        if (cancelled) return;
        applySafeArea(context?.client.safeAreaInsets);
        document.documentElement.dataset.miniapp = "true";
        setState({ status: "inside", isMiniApp: true, context });
        // Last, and unconditionally: the splash comes down even if the context read went wrong.
        await sdk.actions.ready();
      } catch {
        outside();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useExternalLinks(state.status === "inside");

  return (
    <MiniAppCtx.Provider value={state}>
      <MiniAppAutoConnect inside={state.status === "inside"} />
      {children}
    </MiniAppCtx.Provider>
  );
}

/** Connects the host wallet once, and does not fight the user if they disconnect it afterwards. */
function MiniAppAutoConnect({ inside }: { inside: boolean }) {
  const { isConnected, status } = useAccount();
  const { connectors, connect } = useConnect();
  const tried = useRef(false);

  useEffect(() => {
    if (!inside || tried.current) return;
    // "connecting"/"reconnecting" means wagmi is already restoring a session; let it finish.
    if (isConnected || status !== "disconnected") return;
    const connector = connectors.find((c) => c.id === MINI_APP_CONNECTOR_ID);
    if (!connector) return;
    tried.current = true;
    connect({ connector, chainId: BASE_CHAIN_ID });
  }, [inside, isConnected, status, connectors, connect]);

  return null;
}

/**
 * Send links that leave the site through the host.
 *
 * A mini app runs in an iframe or a WebView, and `target="_blank"` there is not a new tab — it is
 * either silently dropped or it replaces the app with Basescan and no way back. Rather than rewrite
 * every explorer, docs and X link in the app, and remember to for every one added later, the click
 * is caught once on the way up and handed to the host.
 *
 * Only cross-origin http(s) links, only a plain left click: in-app navigation, modified clicks that
 * the user means to open their own way, and `mailto:`/fragment links are all left alone.
 */
function useExternalLinks(inside: boolean) {
  useEffect(() => {
    if (!inside) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const clicked = event.target;
      if (!(clicked instanceof Element)) return;
      const anchor = clicked.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const target = externalTarget(anchor.href, window.location.href);
      if (!target) return;
      event.preventDefault();
      void openExternal(target);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [inside]);
}
