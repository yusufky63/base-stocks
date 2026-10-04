"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { TIMEFRAMES, type Timeframe } from "@/domain/market";
import { useAssets } from "@/hooks/queries";
import { CURATED_B20_ASSETS } from "@/lib/b20/registry";
import { isListed } from "@/lib/trading-status";
import {
  APP_URL,
  EMBED_HEIGHT,
  EMBED_SECTION_LABELS,
  EMBED_SECTIONS,
  contrastRatio,
  embedPath,
  embedResizeScript,
  embedSnippet,
  parseEmbedAccent,
  type EmbedEligibility,
  type EmbedOptions,
  type EmbedSection,
  type EmbedSide,
  type EmbedTheme,
  type EmbedWidget,
} from "@/lib/embed";
import { Chip, KeyValue, Module, ModuleHeader } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/Segmented";

/** The site's own primary, what the colour picker starts from. */
const SITE_PRIMARY = "#0370fd";
const DEFAULT_ASSET = CURATED_B20_ASSETS.find((a) => a.underlying === "NVDA")?.address ?? CURATED_B20_ASSETS[0]!.address;

/** The colour as typed, applied to the code and the preview once typing pauses. */
function useSettled<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/** Pick a widget and its options, copy the iframe, and see the widget itself beside the code. */
export function WidgetBuilder({ initialAsset }: { initialAsset?: string }) {
  const [widget, setWidget] = useState<EmbedWidget>("trade");
  const [asset, setAsset] = useState(initialAsset ?? DEFAULT_ASSET);
  // The trading catalog once it has loaded, so a stock listed after the last deploy can be picked; the bootstrap list until then.
  const { data: catalog } = useAssets();
  const stocks = catalog ? catalog.assets.filter(isListed).map((a) => ({ address: a.address, underlying: a.underlying })) : CURATED_B20_ASSETS;
  const [side, setSide] = useState<EmbedSide>("buy");
  const [range, setRange] = useState<Timeframe>("1M");
  const [theme, setTheme] = useState<EmbedTheme>("auto");
  const [eligibility, setEligibility] = useState<EmbedEligibility>("region");
  const [hide, setHide] = useState<EmbedSection[]>([]);
  const [accentText, setAccentText] = useState("");
  const accentDraft = parseEmbedAccent(accentText);
  const accent = useSettled(accentDraft);
  const sections: readonly EmbedSection[] = EMBED_SECTIONS[widget];
  const toggleHide = (section: EmbedSection) => setHide((current) => (current.includes(section) ? current.filter((s) => s !== section) : [...current, section]));

  const options: EmbedOptions = { widget, asset, side, range, theme, eligibility, hide, accent };
  const path = embedPath(options);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_480px] gap-5 items-start">
      <div className="flex flex-col gap-5 min-w-0">
        <Module>
          <ModuleHeader title="Widget" />
          <div className="p-4 flex flex-col gap-4">
            <Segmented<EmbedWidget>
              ariaLabel="Widget"
              value={widget}
              onChange={setWidget}
              options={[
                { value: "trade", label: "Trade" },
                { value: "stock", label: "Stock price" },
              ]}
            />
            <p className="text-[13px] text-ink-secondary">
              {widget === "trade"
                ? "Buy and sell one stock with the live quote, route, slippage and review step the stock page has. Visitors trade from their own wallet."
                : "A stock's price, its daily move, the chart and the market behind it, kept live. Buy and Sell open the trade widget in the same frame."}
            </p>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-ink-secondary">Stock</span>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Stock">
                {stocks.map((a) => (
                  <Chip key={a.address} active={asset.toLowerCase() === a.address.toLowerCase()} onClick={() => setAsset(a.address)} role="radio" aria-checked={asset.toLowerCase() === a.address.toLowerCase()}>
                    {a.underlying}
                  </Chip>
                ))}
              </div>
            </div>
            {widget === "trade" ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] text-ink-secondary">Opens on</span>
                <Segmented<EmbedSide>
                  ariaLabel="Side the widget opens on"
                  size="sm"
                  value={side}
                  onChange={setSide}
                  options={[
                    { value: "buy", label: "Buy", tone: "buy" },
                    { value: "sell", label: "Sell", tone: "sell" },
                  ]}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] text-ink-secondary">Chart opens on</span>
                <Segmented<Timeframe> ariaLabel="Chart range" size="sm" value={range} onChange={setRange} options={TIMEFRAMES.map((t) => ({ value: t, label: t }))} />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-ink-secondary">Theme</span>
              <Segmented<EmbedTheme>
                ariaLabel="Widget theme"
                size="sm"
                value={theme}
                onChange={setTheme}
                options={[
                  { value: "auto", label: "Visitor setting" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-ink-secondary">Eligibility check</span>
              <Segmented<EmbedEligibility>
                ariaLabel="Who the widget asks to confirm they are not a US person"
                size="sm"
                value={eligibility}
                onChange={setEligibility}
                options={[
                  { value: "region", label: "Restricted regions" },
                  { value: "always", label: "Every visitor" },
                ]}
              />
              <p className="text-[12px] text-ink-muted">
                {eligibility === "always"
                  ? "Every visitor confirms they are not a US person (they do not live in the United States and are not a US citizen or resident) once, where the trade button is, before their first trade."
                  : "Only visitors whose connection comes from a restricted country (the United States) are asked, where the trade button is; BStocks refuses their orders until they confirm."}
              </p>
            </div>
          </div>
        </Module>

        <Module>
          <ModuleHeader title="Style" />
          <div className="p-4 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-ink-secondary">Primary colour</span>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="color"
                  aria-label="Pick the primary colour"
                  value={accentDraft ?? SITE_PRIMARY}
                  onChange={(e) => setAccentText(e.target.value)}
                  className="h-9 w-12 shrink-0 cursor-pointer rounded-[6px] border border-line bg-canvas p-1"
                />
                <input
                  aria-label="Primary colour as hex"
                  value={accentText}
                  onChange={(e) => setAccentText(e.target.value)}
                  placeholder="Site blue"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-9 w-32 rounded-[6px] border border-line bg-canvas px-2.5 font-mono text-[13px] outline-none focus:border-primary"
                />
                {accentText && (
                  <Chip onClick={() => setAccentText("")} aria-label="Back to the site colour">
                    Reset
                  </Chip>
                )}
              </div>
              {accentText && !accentDraft && <p className="text-[12px] text-danger-fg">Use a six-digit hex colour, like #0052ff.</p>}
              {accentDraft && <AccentContrast accent={accentDraft} />}
              <p className="text-[12px] text-ink-muted">Buttons, links, the selected tab, the focus ring and the chart line take this colour in light and dark; the shades are derived from it.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-ink-secondary">Hide</span>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Sections to hide">
                {sections.map((section) => (
                  <Chip key={section} active={hide.includes(section)} aria-pressed={hide.includes(section)} onClick={() => toggleHide(section)}>
                    {EMBED_SECTION_LABELS[section]}
                  </Chip>
                ))}
              </div>
              <p className="text-[12px] text-ink-muted">
                {widget === "trade"
                  ? "A hidden option keeps its plain default: pay with USDC, the automatic route, no gift, no limit orders. The price, the quote, the fees, the review step and the eligibility question always stay."
                  : "The name, the price and the daily move always stay."}
              </p>
            </div>
          </div>
        </Module>

        <Module>
          <ModuleHeader title="Code" />
          <div className="p-4 flex flex-col gap-4">
            <CodeBlock label="Paste into your page" code={embedSnippet(APP_URL, options)} />
            <CodeBlock label="Optional · fit the frame to the widget" code={embedResizeScript(APP_URL)} />
            <p className="text-[12px] text-ink-muted">
              Without the script the frame keeps the height in the code ({EMBED_HEIGHT[widget]}px) and scrolls inside when the widget grows. Leave the iframe unsandboxed: wallets open popups and browser wallets inject into the frame.
            </p>
          </div>
        </Module>

        <Module>
          <ModuleHeader title="Events" />
          <div className="p-4 flex flex-col gap-3">
            <p className="text-[13px] text-ink-secondary">
              The widget posts messages to your page with <code className="font-mono text-[12px]">source: &apos;bstocks&apos;</code>. Check <code className="font-mono text-[12px]">event.origin</code> is <code className="font-mono text-[12px]">{new URL(APP_URL).origin}</code>.
            </p>
            <div>
              <KeyValue k="ready" v="{ widget }" />
              <KeyValue k="resize" v="{ height }" />
              <KeyValue k="trade" v="{ asset, side, txHash }" />
            </div>
            <p className="text-[12px] text-ink-muted">
              A limit order or a CoW order settles later, so its <code className="font-mono">txHash</code> is null. Any page can post a message that looks like these: treat a trade as a hint to refresh your UI, and look the transaction up on Base before you reward anyone for it. No address, balance or signature leaves the widget.
            </p>
          </div>
        </Module>
      </div>

      <Module ticks>
        <ModuleHeader title="Preview" />
        <div className="p-3 bg-surface">
          <iframe key={path} src={path} title={widget === "trade" ? "Trade widget preview" : "Stock widget preview"} className="block w-full border-0 rounded-[8px] bg-canvas" style={{ height: EMBED_HEIGHT[widget] }} allow="clipboard-write" />
        </div>
      </Module>
    </div>
  );
}

/** A colour a visitor cannot read is worse than the site's blue: say so while the host picks it. */
function AccentContrast({ accent }: { accent: string }) {
  const onLight = contrastRatio(accent, "#ffffff");
  const onDark = contrastRatio(accent, "#0a0b0d");
  const weak = [onLight < 3 && "light", onDark < 3 && "dark"].filter(Boolean);
  if (weak.length === 0) return null;
  return (
    <p className="text-[12px] text-warning-fg">
      Hard to read as text on {weak.join(" and ")} backgrounds (contrast {Math.min(onLight, onDark).toFixed(1)}:1, 3:1 or more reads well).
    </p>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="border border-line rounded-[6px] overflow-hidden">
      <div className="flex items-center justify-between gap-2 h-9 px-3 border-b border-line bg-surface">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{label}</span>
        <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 h-7 px-2 rounded-[6px] text-[12px] text-ink-secondary hover:text-ink transition-fast">
          {copied ? <Check size={13} strokeWidth={1.75} /> : <Copy size={13} strokeWidth={1.75} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-[12px] leading-relaxed font-mono text-ink">
        <code>{code}</code>
      </pre>
    </div>
  );
}
