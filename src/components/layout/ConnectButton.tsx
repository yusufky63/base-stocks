"use client";

import { useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { ChevronDown, Wallet } from "lucide-react";
import type { Address } from "viem";
import { hasReown } from "@/config/wagmi";
import { getAppKit } from "@/config/appkit";
import { BASE_CHAIN_ID } from "@/config/chain";
import { Button, cx } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/Sheet";
import { useBasename } from "@/hooks/queries";
import { shortenAddress } from "@/lib/format";
import { AddressLabel } from "@/components/common/display";

/**
 * Wallet entry point. Uses the AppKit modal when configured, otherwise a minimal picker
 * over the same Wagmi connectors (Base Account first, then injected wallets).
 * No signature is requested on connect (spec §19).
 */
export function ConnectButton({ size = "md", full, compact }: { size?: "sm" | "md" | "lg"; full?: boolean; compact?: boolean }) {
  const { address, isConnected, chainId } = useAccount();
  const [open, setOpen] = useState(false);
  const { switchChain, isPending: switching } = useSwitchChain();

  const openWallet = () => {
    const kit = hasReown ? getAppKit() : null;
    if (kit) void kit.open();
    else setOpen(true);
  };

  if (isConnected && address) {
    if (chainId !== BASE_CHAIN_ID) {
      return (
        <Button size={size} full={full} variant="danger" loading={switching} onClick={() => switchChain({ chainId: BASE_CHAIN_ID })}>
          Switch to Base
        </Button>
      );
    }
    return (
      <>
        <AccountChip address={address} onClick={openWallet} compact={compact} full={full} />
        {open && <FallbackWalletSheet open={open} onClose={() => setOpen(false)} />}
      </>
    );
  }

  return (
    <>
      <Button size={size} full={full} onClick={openWallet} className={cx(compact && "h-9 min-h-[36px] px-3")}>
        <Wallet size={16} strokeWidth={1.75} /> {compact ? "Connect" : "Connect wallet"}
      </Button>
      {open && <FallbackWalletSheet open={open} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Connected identity: wallet icon, Basename or short address, mono, one clean bordered chip. */
function AccountChip({ address, onClick, compact, full }: { address: Address; onClick: () => void; compact?: boolean; full?: boolean }) {
  const { data } = useBasename(address);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Wallet menu"
      className={cx(
        "inline-flex items-center gap-2 rounded-[6px] border border-line bg-canvas hover:border-ink transition-fast",
        compact ? "h-9 px-2.5" : "h-11 px-3",
        full && "w-full justify-between",
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

  const ordered = [...connectors].sort((a, b) => rank(a.id) - rank(b.id));

  return (
    <Sheet open={open} onClose={onClose} title={isConnected ? "Wallet" : "Connect a wallet"}>
      {isConnected && address ? (
        <div className="flex flex-col gap-4">
          <AddressLabel address={address} explorer />
          <p className="text-[14px] text-ink-secondary">You stay in control of your assets. BStocks never holds keys or funds.</p>
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
              className="rail flex items-center justify-between min-h-[52px] px-4 rounded-[6px] border border-line hover:border-ink text-left transition-fast disabled:opacity-50"
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
  if (id === "baseAccount") return 0;
  if (id === "coinbaseWalletSDK") return 1;
  if (id === "injected") return 9;
  return 5;
}

function friendlyName(id: string, name: string): string {
  if (id === "baseAccount") return "Base Account";
  if (id === "injected") return "Browser wallet";
  return name;
}
