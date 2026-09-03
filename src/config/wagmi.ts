import { cookieStorage, createConfig, createStorage, fallback, http, type Config } from "wagmi";
import { base } from "wagmi/chains";
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

function buildConnectors() {
  return [
    baseAccount({
      appName: APP_NAME,
      appLogoUrl: `${publicEnv.appUrl}/brand/icon-1024.png`,
      ...(publicEnv.paymasterUrl ? { paymasterUrls: { [BASE_CHAIN_ID]: publicEnv.paymasterUrl } } : {}),
    }),
    injected({ shimDisconnect: true }),
  ];
}

const storage = createStorage({ storage: cookieStorage });

export const wagmiAdapter: WagmiAdapter | null = hasReown
  ? new WagmiAdapter({
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
