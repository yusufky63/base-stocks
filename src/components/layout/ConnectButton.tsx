"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { ChevronDown, Wallet } from "lucide-react";
import type { Address } from "viem";
import { MINI_APP_CONNECTOR_ID, hasReown } from "@/config/wagmi";
import { ensureAppKit, getAppKit, warmAppKit } from "@/config/appkit";
import { useTheme } from "./ThemeProvider";
import { BASE_CHAIN_ID } from "@/config/chain";
import { Button, cx } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/Sheet";
import { useBasename } from "@/hooks/queries";
import { shortenAddress } from "@/lib/format";
import { AddressLabel } from "@/components/common/display";
import { useMiniApp } from "@/components/layout/MiniAppProvider";

/**
 * Wallet entry point. Uses the AppKit modal when configured, otherwise a minimal picker
 * over the same Wagmi connectors (Base Account first, then injected wallets).
 * No signature is requested on connect (spec §19).
 */
export function ConnectButton({ size = "md", full, compact }: { size?: "sm" | "md" | "lg"; full?: boolean; compact?: boolean }) {
  const { address, isConnected, chainId, status, connector } = useAccount();
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const [switchError, setSwitchError] = useState<string | null>(null);
  const { disconnect } = useDisconnect();
  const { isMiniApp } = useMiniApp();
  const { connectors, connect } = useConnect();
  const { resolved: theme } = useTheme();

  // A wallet extension can answer eth_accounts with an empty list (locked, or a second extension
  // owning window.ethereum) while Wagmi still reports "connected". AppKit then looks up the
  // identity of address "undefined" (400 from rpc.walletconnect.org) and the header shows a ghost
  // session. Drop that connection so the user sees "Connect wallet" and picks the right one.
  useEffect(() => {
    if (status === "connected" && !address) disconnect();
  }, [status, address, disconnect]);

  // The modal is loaded on intent rather than on idle (see AppKitBoot): a pointer or focus arriving
  // on this button is the clearest sign there is, and it gives the ~686 KB a head start on the tap.
  const warm = () => {
    if (hasReown && !isMiniApp) warmAppKit(theme);
  };

  const openWallet = () => {
    // In the Base app there is one wallet and it is the host's own. AppKit would offer a choice
    // that does not exist there, in a modal that belongs to someone else's frame, so the host
    // connector is used directly and the sheet is kept for showing the account afterwards.
    if (isMiniApp) {
      const host = connectors.find((c) => c.id === MINI_APP_CONNECTOR_ID);
      if (host && !isConnected) {
        connect({ connector: host, chainId: BASE_CHAIN_ID });
        return;
      }
      setOpen(true);
      return;
    }
    if (!hasReown) {
      setOpen(true);
      return;
    }
    // open() resolves once the modal is on screen (after its wallet list has loaded); until then the
    // button shows it is working instead of looking like it ignored the tap. The modal itself is
    // loaded on demand, so the first tap may also be waiting for the module.
    if (opening) return;
    setOpening(true);
    void (getAppKit() ? Promise.resolve(getAppKit()) : ensureAppKit(theme))
      .then((kit) => (kit ? kit.open() : setOpen(true)))
      .finally(() => setOpening(false));
  };

  if (isConnected && address) {
    // Only a settled connection can be on the wrong chain; while reconnecting the chain id is not known yet.
    if (status === "connected" && chainId !== undefined && chainId !== BASE_CHAIN_ID) {
      const switchToBase = async () => {
        setSwitchError(null);
        try {
          // Ask the connector that owns this session, so the request does not land in another
          // installed wallet extension when several are fighting over window.ethereum.
          await switchChainAsync({ chainId: BASE_CHAIN_ID, connector });
        } catch (err) {
          const msg = err instanceof Error ? (err.message.split(/\r?\n/)[0] ?? "") : "";
          setSwitchError(/rejected|denied/i.test(msg) ? "Switch request declined in the wallet." : `This wallet did not switch. Open ${connector?.name ?? "the wallet"} and choose the Base network there, then come back.`);
        }
      };
      return (
        <span className={cx("inline-flex flex-col items-end gap-1", full && "w-full")}>
          <Button size={size} full={full} variant="danger" loading={switching} onClick={() => void switchToBase()} title={`Connected to chain ${chainId}; BaseStocks runs on Base (8453)`}>
            Switch to Base
          </Button>
          {switchError && <span role="alert" className="text-[12px] text-danger-fg text-right max-w-[260px]">{switchError}</span>}
        </span>
      );
    }
    return (
      <>
        <AccountChip address={address} onClick={openWallet} onIntent={warm} compact={compact} full={full} busy={opening} />
        {open && <FallbackWalletSheet open={open} onClose={() => setOpen(false)} />}
      </>
    );
  }

  return (
    <>
      <Button size={size} full={full} loading={opening} onClick={openWallet} onPointerEnter={warm} onFocus={warm} className={cx(compact && "h-9 min-h-[36px] px-3")}>
        <Wallet size={16} strokeWidth={1.75} /> {compact ? "Connect" : "Connect wallet"}
      </Button>
      {open && <FallbackWalletSheet open={open} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Connected identity: wallet icon, Basename or short address, mono, one clean bordered chip. */
function AccountChip({ address, onClick, onIntent, compact, full, busy }: { address: Address; onClick: () => void; onIntent?: () => void; compact?: boolean; full?: boolean; busy?: boolean }) {
  const { data } = useBasename(address);
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerEnter={onIntent}
      onFocus={onIntent}
      aria-label="Wallet menu"
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex items-center gap-2 rounded-[6px] border border-line bg-canvas hover:border-line-strong transition-fast",
        compact ? "h-9 px-2.5" : "h-11 px-3",
        full && "w-full justify-between",
        busy && "opacity-70 cursor-progress",
      )}
    >
      <Wallet size={14} strokeWidth={1.75} className="text-ink-secondary" aria-hidden />
      <span className={cx("font-mono num", compact ? "text-[12px]" : "text-[13px]")}>{data?.name ?? shortenAddress(address, 4)}</span>
      <ChevronDown size={14} strokeWidth={1.75} className="text-ink-muted" />
    </button>
  );
}

function FallbackWalletSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { connectors, connectAsync, isPending, error } = useConnect();
  const { isConnected, address } = useAccount();
  const { disconnect } = useDisconnect();

  // With several wallet extensions installed, EIP-6963 announces each one as its own connector;
  // the generic "injected" entry (whatever owns window.ethereum) is then redundant and ambiguous.
  const discovered = connectors.some((c) => c.type === "injected" && c.id !== "injected");
  const ordered = connectors.filter((c) => !(discovered && c.id === "injected")).sort((a, b) => rank(a.id) - rank(b.id));

  return (
    <Sheet open={open} onClose={onClose} title={isConnected ? "Wallet" : "Connect a wallet"}>
      {isConnected && address ? (
        <div className="flex flex-col gap-4">
          <AddressLabel address={address} explorer />
          <p className="text-[14px] text-ink-secondary">You stay in control of your assets. BaseStocks never holds keys or funds.</p>
          <Button
            variant="secondary"
            onClick={() => {
              disconnect();
              onClose();
            }}
          >
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {ordered.map((c) => (
            <button
              key={c.uid}
              type="button"
              disabled={isPending}
              onClick={async () => {
                try {
                  await connectAsync({ connector: c, chainId: BASE_CHAIN_ID });
                  onClose();
                } catch {
                  /* surfaced via error below */
                }
              }}
              className="rail flex items-center justify-between min-h-[52px] px-4 rounded-[6px] border border-line hover:border-line-strong text-left transition-fast disabled:opacity-50"
            >
              <span className="font-medium">{friendlyName(c.id, c.name)}</span>
              {c.id === "baseAccount" && <span className="eyebrow text-primary">Recommended</span>}
            </button>
          ))}
          {error && <p className="text-[13px] text-danger-fg">{error.message.split("\n")[0]}</p>}
          <p className="text-[12px] text-ink-muted mt-2">Base Account uses a passkey. Other wallets connect through their own extension or app. No signature is requested on connect.</p>
        </div>
      )}
    </Sheet>
  );
}

function rank(id: string): number {
  if (id === MINI_APP_CONNECTOR_ID) return -1;
  if (id === "baseAccount") return 0;
  if (id === "coinbaseWalletSDK") return 1;
  if (id === "injected") return 9;
  return 5;
}

function friendlyName(id: string, name: string): string {
  if (id === MINI_APP_CONNECTOR_ID) return "Base app wallet";
  if (id === "baseAccount") return "Base Account";
  if (id === "injected") return "Browser wallet";
  return name;
}
