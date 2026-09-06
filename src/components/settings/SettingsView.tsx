"use client";

import { useState } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { useTheme, type ThemePreference } from "@/components/layout/ThemeProvider";
import { useMotion, type MotionPreference } from "@/lib/motion";
import { useSlippage, useTickerSettings } from "@/hooks/useSettings";
import { useConfigFlags } from "@/hooks/queries";
import { isAttributionEnabled } from "@/lib/attribution";
import { Module, ModuleHeader, Chip, Button, KeyValue } from "@/components/ui/primitives";
import { useMiniApp } from "@/components/layout/MiniAppProvider";
import { addMiniApp } from "@/lib/miniapp-actions";
import { ConnectButton } from "@/components/layout/ConnectButton";
import { AddressLabel, LegalNotice } from "@/components/common/display";

export function SettingsView() {
  const { preference, setPreference } = useTheme();
  const motion = useMotion();
  const ticker = useTickerSettings();
  const { slippageBps, setSlippageBps } = useSlippage();
  const { address, connector } = useAccount();
  const { disconnect } = useDisconnect();
  const { data: flags } = useConfigFlags();

  return (
    <div className="flex flex-col gap-6 max-w-[720px]">
      <div>
        <div className="eyebrow mb-2">Settings</div>
        <h1 className="display text-[36px] md:text-[48px] leading-none">Preferences</h1>
      </div>

      <Module>
        <ModuleHeader title="Wallet" />
        <div className="p-4 flex flex-col gap-3">
          {address ? (
            <>
              <AddressLabel address={address} explorer />
              <KeyValue k="Connector" v={connector?.name ?? "—"} mono={false} />
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => disconnect()}>
                  Disconnect
                </Button>
              </div>
            </>
          ) : (
            <ConnectButton />
          )}
          <p className="text-[12px] text-ink-muted">BaseStocks never holds keys or funds. No signature is requested on connect or page load.</p>
        </div>
      </Module>

      <SaveToBaseApp />

      <Module>
        <ModuleHeader title="Appearance" />
        <div className="p-4 flex flex-col gap-4">
          <div>
            <div className="eyebrow mb-2">Theme</div>
            <div className="flex gap-2">
              {(["system", "light", "dark"] as ThemePreference[]).map((p) => (
                <Chip key={p} active={preference === p} onClick={() => setPreference(p)}>
                  {p[0]!.toUpperCase() + p.slice(1)}
                </Chip>
              ))}
            </div>
          </div>
          <div>
            <div className="eyebrow mb-2">Motion</div>
            <div className="flex gap-2">
              {(["on", "system", "off"] as MotionPreference[]).map((p) => (
                <Chip key={p} active={motion.preference === p} onClick={() => motion.setPreference(p)}>
                  {p === "on" ? "On" : p === "off" ? "Off" : "Follow system"}
                </Chip>
              ))}
            </div>
            <p className="mt-2 text-[12px] text-ink-muted">
              Controls the ticker, hero effects and number transitions. “Follow system” respects your OS “reduce motion” setting{motion.preference === "system" && !motion.enabled ? " (currently reducing motion)" : ""}.
            </p>
          </div>
        </div>
      </Module>

      <Module>
        <ModuleHeader title="Top ticker" />
        <div className="p-4 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[14px] font-medium">Prices row</div>
              <div className="text-[12px] text-ink-muted">Live prices for all 13 stocks. On by default.</div>
            </div>
            <div className="flex gap-2">
              <Chip active={ticker.prices} onClick={() => ticker.set({ prices: true })}>
                On
              </Chip>
              <Chip active={!ticker.prices} onClick={() => ticker.set({ prices: false })}>
                Off
              </Chip>
            </div>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[14px] font-medium">Headlines row</div>
              <div className="text-[12px] text-ink-muted">Scrolling news from the News page. Off by default.</div>
            </div>
            <div className="flex gap-2">
              <Chip active={ticker.news} onClick={() => ticker.set({ news: true })}>
                On
              </Chip>
              <Chip active={!ticker.news} onClick={() => ticker.set({ news: false })}>
                Off
              </Chip>
            </div>
          </div>
        </div>
      </Module>

      <Module>
        <ModuleHeader title="Trading" />
        <div className="p-4 flex flex-col gap-3">
          <div className="text-[13px] text-ink-secondary">Slippage tolerance</div>
          <div className="flex gap-2 flex-wrap">
            {[50, 100, 200, 300].map((b) => (
              <Chip key={b} active={slippageBps === b} onClick={() => setSlippageBps(b)}>
                {(b / 100).toFixed(1)}%
              </Chip>
            ))}
          </div>
          <p className="text-[12px] text-ink-muted">Approvals are scoped to the exact amount of each trade and only ever granted to the spender returned by the execution provider.</p>
        </div>
      </Module>

      <Module>
        <ModuleHeader title="Availability & legal" />
        <div className="p-4">
          <LegalNotice />
        </div>
      </Module>

      {/* Developer-facing details stay out of the way: collapsed, no visual weight. */}
      <details className="group border border-dashed border-line rounded-[8px] text-ink-muted">
        <summary className="cursor-pointer select-none px-4 py-3 font-mono text-[11px] uppercase tracking-[0.08em]">Diagnostics (for developers) · <a href="/status" className="text-primary normal-case tracking-normal">full status page</a></summary>
        <div className="px-4 pb-4 flex flex-col gap-2 text-[13px]">
          {flags ? (
            <>
              <KeyValue k="Execution providers" v={flags.tradeProviders.join(" → ") || "none configured"} />
              <KeyValue
                k="0x tokenized stocks"
                v={!flags.zeroX?.configured ? "no API key" : flags.zeroX.refusesTokenizedStocks ? `refused by 0x (opt-in pending)${flags.zeroX.retryAt ? ` · re-check ${new Date(flags.zeroX.retryAt).toLocaleTimeString()}` : ""}` : "enabled"}
              />
              <KeyValue k="Geoblock (execution routes)" v={flags.geoblockCountries && flags.geoblockCountries.length > 0 ? flags.geoblockCountries.join(", ") : "off"} />
              <KeyValue k="Market data" v={flags.marketDataEnabled ? "enabled" : "degraded (reference prices only)"} />
              <KeyValue k="Builder Code attribution" v={isAttributionEnabled() ? "enabled" : "not configured"} />
              <KeyValue k="Storage" v={flags.storage} />
            </>
          ) : (
            <span>Loading…</span>
          )}
        </div>
      </details>
    </div>
  );
}

/**
 * Saving BaseStocks alongside the user's other mini apps.
 *
 * Only shown where it means something: inside a host, and only while the app is not already saved.
 * The host runs its own confirmation, and declining is an ordinary answer — the row simply stays.
 */
function SaveToBaseApp() {
  const { isMiniApp, context } = useMiniApp();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  if (!isMiniApp || context?.client.added || saved) return null;

  const save = async () => {
    setSaving(true);
    setSaved(await addMiniApp());
    setSaving(false);
  };

  return (
    <Module>
      <ModuleHeader title="Base app" />
      <div className="p-4 flex flex-col gap-3">
        <Button variant="secondary" loading={saving} onClick={() => void save()} className="self-start">
          Save BaseStocks to my apps
        </Button>
        <p className="text-[12px] text-ink-muted">Keeps BaseStocks in your app list so you can open it without the link.</p>
      </div>
    </Module>
  );
}
