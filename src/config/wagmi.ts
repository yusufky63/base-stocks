import { cookieStorage, createConfig, createStorage, fallback, http, type Config } from "wagmi";
import { getBalance } from "wagmi/actions";
import { base } from "wagmi/chains";
import { formatUnits, type Address } from "viem";
import { baseAccount, injected } from "wagmi/connectors";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { base as appkitBase, type AppKitNetwork } from "@reown/appkit/networks";
import { publicEnv } from "@/config/env";
import { BASE_CHAIN_ID, PUBLIC_BASE_RPC_URLS } from "@/config/chain";

/**
 * Wallet stack (spec §18): Reown AppKit + Wagmi + Viem, Base Account featured but never exclusive.
 * When no Reown project id is configured we fall back to a plain Wagmi config with the same
 * connectors so Base Account + injected wallets keep working.
 */
export const APP_NAME = "BStocks";
export const projectId = publicEnv.reownProjectId;
export const hasReown = projectId.length > 0;
export const networks = [appkitBase] as [AppKitNetwork, ...AppKitNetwork[]];

// Dedicated browser RPC first, public Base endpoints behind it, in order (no latency ranking).
const rpcChain = [
  ...(publicEnv.baseRpcUrl ? [http(publicEnv.baseRpcUrl, { batch: true, retryCount: 2 })] : []),
  ...PUBLIC_BASE_RPC_URLS.filter((u) => u !== publicEnv.baseRpcUrl).map((u) => http(u, { batch: true, retryCount: 1 })),
];
const transports = {
  [base.id]: fallback(rpcChain, { rank: false }),
} as const;

/** The id the Farcaster/Base app connector registers itself under. */
export const MINI_APP_CONNECTOR_ID = "farcaster";

/**
 * Whether this page could be running inside a mini app host — an iframe, or a React Native WebView.
 *
 * The same synchronous short-circuit the SDK itself makes before it tries to talk to a host, and
 * the reason the host connector is added conditionally rather than always. Outside a host there is
 * nobody on the other end of the postMessage channel, so `eth_accounts` would never answer and
 * wagmi's reconnect on load would sit waiting on a wallet that does not exist.
 */
export function couldBeMiniAppHost(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as { ReactNativeWebView?: unknown }).ReactNativeWebView) || window !== window.parent;
}

function buildConnectors() {
  return [
    // Inside the Base app the wallet is the host's own; its connector is registered on the fly by
    // `registerMiniAppConnector` once the host is confirmed, so the SDK behind it (~400 KB) is
    // never downloaded by a visitor in an ordinary tab.
    baseAccount({
      appName: APP_NAME,
      appLogoUrl: `${publicEnv.appUrl}/brand/icon-1024.png`,
      ...(publicEnv.paymasterUrl ? { paymasterUrls: { [BASE_CHAIN_ID]: publicEnv.paymasterUrl } } : {}),
    }),
    injected({ shimDisconnect: true }),
  ];
}

/**
 * AppKit's Wagmi adapter (1.8.x) reads `balance.formatted` from Wagmi's getBalance — a field Wagmi 3
 * removed — so the account view said "0.000 ETH" for every wallet, whatever it held. The adapter's
 * contract is a formatted string; it is produced here from the value and decimals Wagmi 3 does return.
 * One request per address at a time, and a failure reads as zero rather than as an error in the modal.
 */
class BalanceAwareWagmiAdapter extends WagmiAdapter {
  private readonly balanceInFlight = new Map<string, ReturnType<WagmiAdapter["getBalance"]>>();

  override getBalance(params: Parameters<WagmiAdapter["getBalance"]>[0]): ReturnType<WagmiAdapter["getBalance"]> {
    const chainId = Number(params.chainId);
    if (!params.address || !Number.isFinite(chainId)) return Promise.resolve({ balance: "0.00", symbol: "ETH" });
    const key = `${chainId}:${params.address.toLowerCase()}`;
    const pending = this.balanceInFlight.get(key);
    if (pending) return pending;
    const task = getBalance(this.wagmiConfig, { address: params.address as Address, chainId })
      .then((b) => ({ balance: formatUnits(b.value, b.decimals), symbol: b.symbol }))
      .catch(() => ({ balance: "0.00", symbol: "ETH" }))
      .finally(() => this.balanceInFlight.delete(key));
    this.balanceInFlight.set(key, task);
    return task;
  }
}

const storage = createStorage({ storage: cookieStorage });

export const wagmiAdapter: WagmiAdapter | null = hasReown
  ? new BalanceAwareWagmiAdapter({
      ssr: true,
      projectId,
      networks,
      connectors: buildConnectors(),
      transports,
      storage,
    })
  : null;

export const wagmiConfig: Config = wagmiAdapter
  ? wagmiAdapter.wagmiConfig
  : createConfig({
      chains: [base],
      connectors: buildConnectors(),
      transports,
      ssr: true,
      storage,
      multiInjectedProviderDiscovery: true,
    });

let miniAppConnectorRegistered: Promise<void> | null = null;

/**
 * Adds the host wallet's connector to the running wagmi config, first in the list, and only
 * once the page knows it is inside a mini app host. wagmi keeps its connectors in a store that
 * accepts late additions (that is how it discovers injected wallets after load), so nothing about
 * the provider tree changes; `useConnect` sees the new connector on its next render.
 */
export function registerMiniAppConnector(): Promise<void> {
  miniAppConnectorRegistered ??= import("@farcaster/miniapp-wagmi-connector").then(({ farcasterMiniApp }) => {
    const store = wagmiConfig._internal.connectors;
    if (wagmiConfig.connectors.some((c) => c.id === MINI_APP_CONNECTOR_ID)) return;
    const connector = store.setup(farcasterMiniApp());
    store.setState((current) => [connector, ...current]);
  });
  return miniAppConnectorRegistered;
}
