import { TIMEFRAMES, type Timeframe } from "@/domain/market";

/**
 * Widgets: a stock's buy / sell panel and a stock's price card, as pages another site can put in an
 * iframe.
 *
 * Everything under /embed may be framed by any origin (next.config.ts); every other page keeps its
 * named list of mini app hosts. The widget talks to its host only through postMessage, and only to
 * say things the host could read from the chain anyway: its height, that it is ready, and the hash
 * of a trade the visitor just made. No address, balance or signature ever leaves the frame.
 */

/**
 * This site's own address, for the links and code a widget hands out. Read here rather than from
 * the config module, the same way the root layout reads it, so widgets depend on nothing else.
 */
export const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? (process.env.NODE_ENV === "production" ? "https://basestocks.finance" : "http://localhost:3000")).replace(/\/+$/, "");

export type EmbedWidget = "trade" | "stock";
export type EmbedTheme = "auto" | "light" | "dark";
export type EmbedSide = "buy" | "sell";
/**
 * When the trade widget asks the "not a US person" question: `region` only where the server
 * requires it (a blocked country), `always` of every visitor before their first trade. A host picks
 * `always` when it wants the statement from everyone on its own site.
 */
export type EmbedEligibility = "region" | "always";

/**
 * Default frame heights: each widget fits whole at a 420px width. Without the optional resize
 * script a widget that grows (a gift recipient, execution details) scrolls inside its frame.
 */
export const EMBED_HEIGHT: Record<EmbedWidget, number> = { trade: 900, stock: 620 };

/** Every message a widget posts carries this, so a host can tell ours from any other frame's. */
export const EMBED_MESSAGE_SOURCE = "bstocks";

export type EmbedMessage =
  | { type: "ready"; widget: EmbedWidget }
  | { type: "resize"; height: number }
  | { type: "trade"; asset: string; side: EmbedSide; txHash: string | null };

export function embedMessage(message: EmbedMessage): EmbedMessage & { source: typeof EMBED_MESSAGE_SOURCE } {
  return { source: EMBED_MESSAGE_SOURCE, ...message };
}

/**
 * Parts of a widget a host may leave out so it fits the host's page. What a hidden part controls
 * falls back to its plain default: pay with USDC, the automatic route, no gift, no limit orders.
 * The price, the quote, the fees, the review step and the eligibility question are never optional.
 */
export const EMBED_SECTIONS = {
  trade: ["header", "pay", "presets", "gift", "limit", "routes", "details", "fund"],
  stock: ["chart", "range", "stats", "trade"],
} as const satisfies Record<EmbedWidget, readonly string[]>;
export type EmbedSection = (typeof EMBED_SECTIONS)[EmbedWidget][number];
const ALL_SECTIONS = new Set<string>([...EMBED_SECTIONS.trade, ...EMBED_SECTIONS.stock]);

export const EMBED_SECTION_LABELS: Record<EmbedSection, string> = {
  header: "Title",
  pay: "Pay with ETH",
  presets: "Amount slider and presets",
  gift: "Buy for someone else",
  limit: "Limit orders",
  routes: "Route choice",
  details: "Execution details",
  fund: "Add funds",
  chart: "Chart",
  range: "Timeframes",
  stats: "Market stats",
  trade: "Buy and sell buttons",
};

export function parseEmbedTheme(value: string | null | undefined): EmbedTheme {
  return value === "light" || value === "dark" ? value : "auto";
}

export function parseEmbedSide(value: string | null | undefined): EmbedSide {
  return value === "sell" ? "sell" : "buy";
}

export function parseEmbedEligibility(value: string | null | undefined): EmbedEligibility {
  return value === "always" ? "always" : "region";
}

/** `?range=1W`: one of the chart's own timeframes, 1M otherwise (the stock page's default). */
export function parseEmbedRange(value: string | null | undefined): Timeframe {
  const upper = (value ?? "").toUpperCase();
  return (TIMEFRAMES as readonly string[]).includes(upper) ? (upper as Timeframe) : "1M";
}

/** `?hide=gift,limit`: the known sections, once each, in a fixed order; anything else is dropped. */
export function parseEmbedHide(value: string | null | undefined): EmbedSection[] {
  const asked = new Set((value ?? "").split(",").map((part) => part.trim().toLowerCase()));
  return [...ALL_SECTIONS].filter((section) => asked.has(section)) as EmbedSection[];
}

/** `?accent=0052ff` (the `#` optional): a six-digit hex colour, lowercased with its `#`, or null. */
export function parseEmbedAccent(value: string | null | undefined): string | null {
  const hex = (value ?? "").trim().replace(/^#/, "").toLowerCase();
  return /^[0-9a-f]{6}$/.test(hex) ? `#${hex}` : null;
}

export type EmbedOptions = {
  widget: EmbedWidget;
  /** The stock's contract address: widgets are addressed the way the stock pages are. */
  asset: string;
  /** Trade widget: the side it opens on. */
  side?: EmbedSide;
  /** Stock widget: the chart's opening timeframe. */
  range?: Timeframe;
  theme?: EmbedTheme;
  eligibility?: EmbedEligibility;
  /** Sections to leave out; any that do not belong to this widget are ignored. */
  hide?: readonly EmbedSection[];
  /** Primary colour, `#rrggbb`. */
  accent?: string | null;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Commas are legal in a query; left unescaped, `hide=gift,limit` stays readable in the host's code. */
const query = (params: URLSearchParams) => params.toString().replaceAll("%2C", ",");

/** The widget's path on this site, with only the parameters that differ from the defaults. */
export function embedPath(options: EmbedOptions): string {
  if (!ADDRESS.test(options.asset)) throw new Error("A widget needs the stock's contract address.");
  const params = new URLSearchParams();
  const path = `/embed/${options.widget}/${options.asset.toLowerCase()}`;
  if (options.widget === "trade") {
    if (options.side === "sell") params.set("side", "sell");
    if (options.eligibility === "always") params.set("eligibility", "always");
  } else if (options.range && parseEmbedRange(options.range) !== "1M") {
    params.set("range", parseEmbedRange(options.range));
  }
  if (options.theme === "light" || options.theme === "dark") params.set("theme", options.theme);
  const own: readonly string[] = EMBED_SECTIONS[options.widget];
  const hide = parseEmbedHide((options.hide ?? []).join(",")).filter((section) => own.includes(section));
  if (hide.length > 0) params.set("hide", hide.join(","));
  const accent = parseEmbedAccent(options.accent);
  if (accent) params.set("accent", accent.slice(1));
  const q = query(params);
  return q ? `${path}?${q}` : path;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The iframe a host pastes. Not sandboxed: wallets open popups and extensions inject into the frame. */
export function embedSnippet(appUrl: string, options: EmbedOptions): string {
  const src = `${appUrl.replace(/\/+$/, "")}${embedPath(options)}`;
  const title = options.widget === "trade" ? "Trade on BStocks" : "Stock price on BStocks";
  return [
    "<iframe",
    `  src="${escapeAttribute(src)}"`,
    `  title="${title}"`,
    `  width="100%" height="${EMBED_HEIGHT[options.widget]}"`,
    '  style="border:0;max-width:480px;border-radius:8px"',
    '  allow="clipboard-write"',
    '  loading="lazy"',
    "></iframe>",
  ].join("\n");
}

/**
 * Optional host script: grows each widget frame to its content. It trusts only messages from this
 * site's origin, and only resizes the frame that sent them.
 */
export function embedResizeScript(appUrl: string): string {
  const origin = new URL(appUrl).origin;
  return [
    "<script>",
    "window.addEventListener('message', function (e) {",
    `  if (e.origin !== '${origin}' || !e.data || e.data.source !== '${EMBED_MESSAGE_SOURCE}' || e.data.type !== 'resize') return;`,
    "  document.querySelectorAll('iframe').forEach(function (f) {",
    "    if (f.contentWindow === e.source) f.style.height = e.data.height + 'px';",
    "  });",
    "});",
    "</script>",
  ].join("\n");
}

/**
 * What a click on a link inside a widget should do. Only widget pages stay in the frame: any other
 * page of this site would show the full site squeezed into the host's box, and other sites mostly
 * refuse to be framed at all, so both open in a new tab. Links that already choose their own
 * target, and anything that is not http(s), are left alone.
 */
export function embedLinkAction(href: string | null, pageUrl: string, target: string | null = null): "frame" | "new-tab" | "default" {
  if (!href || href.startsWith("#")) return "default";
  if (target && target !== "_self") return "default";
  let url: URL;
  let page: URL;
  try {
    page = new URL(pageUrl);
    url = new URL(href, page);
  } catch {
    return "default";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "default";
  if (url.origin === page.origin && (url.pathname === "/embed" || url.pathname.startsWith("/embed/"))) return "frame";
  return "new-tab";
}

/**
 * Keeps the host's look and choices (`theme`, `eligibility`, `accent`, `hide`) when the stock card
 * hands over to the trade widget inside the frame. `hide` goes along whole: each widget ignores the
 * other's sections.
 */
export function withEmbedParams(path: string, search: string): string {
  const current = new URLSearchParams(search);
  const params = new URLSearchParams();
  const theme = parseEmbedTheme(current.get("theme"));
  if (theme !== "auto") params.set("theme", theme);
  if (parseEmbedEligibility(current.get("eligibility")) === "always") params.set("eligibility", "always");
  const accent = parseEmbedAccent(current.get("accent"));
  if (accent) params.set("accent", accent.slice(1));
  const hide = parseEmbedHide(current.get("hide"));
  if (hide.length > 0) params.set("hide", hide.join(","));
  const q = query(params);
  if (!q) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${q}`;
}

/**
 * The root layout's pre-paint script. The visitor's stored theme and motion choice apply
 * everywhere, except that on a widget page a host that names a theme with `?theme=` wins inside its
 * frame. The query is read first: a framed page may be refused storage, and that must not cost the
 * host its theme. Motion defaults to "system": the CSS honours prefers-reduced-motion for anything
 * but an explicit "on".
 */
export const THEME_SCRIPT = `(function(){var d=document.documentElement,t=null;try{if(/^\\/embed(\\/|$)/.test(location.pathname))t=new URLSearchParams(location.search).get('theme');}catch(e){}try{if(t!=='dark'&&t!=='light')t=localStorage.getItem('bstocks:theme');if(t==='dark'||t==='light')d.setAttribute('data-theme',t);var m=localStorage.getItem('bstocks:motion');d.setAttribute('data-motion',(m==='off'||m==='on')?m:'system');}catch(e){if(t==='dark'||t==='light')d.setAttribute('data-theme',t);d.setAttribute('data-motion','system');}})();`;

/** A host's `?theme=` on a widget page, for code that runs after paint (the wallet modal's theme). */
export function embedThemeFromLocation(location: { pathname: string; search: string }): "light" | "dark" | null {
  if (!/^\/embed(\/|$)/.test(location.pathname)) return null;
  const theme = parseEmbedTheme(new URLSearchParams(location.search).get("theme"));
  return theme === "auto" ? null : theme;
}

type Rgb = [number, number, number];
const toRgb = (hex: string): Rgb => [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16)) as Rgb;
const toHex = (rgb: Rgb) => `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;
const mix = (rgb: Rgb, toward: number, amount: number): Rgb => rgb.map((c) => c + (toward - c) * amount) as Rgb;

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(toRgb(a)), luminance(toRgb(b))];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const INK = "#0a0b0d";

/**
 * The site's five primary tokens, derived from one host colour for each theme the way the site's
 * own blue is: a darker pressed shade on light and a lighter one on dark, the colour itself as the
 * button fill, a faint tint, and whichever of white or ink reads better on the fill.
 */
export function accentTokens(accent: string): { light: Record<string, string>; dark: Record<string, string> } {
  const rgb = toRgb(accent);
  const contrast = contrastRatio(accent, "#ffffff") >= contrastRatio(accent, INK) ? "#ffffff" : INK;
  const soft = (alpha: number) => `rgba(${rgb.join(", ")}, ${alpha})`;
  return {
    light: { "--primary": accent, "--primary-strong": toHex(mix(rgb, 0, 0.2)), "--primary-fill": accent, "--primary-soft": soft(0.08), "--primary-contrast": contrast },
    dark: { "--primary": accent, "--primary-strong": toHex(mix(rgb, 255, 0.25)), "--primary-fill": accent, "--primary-soft": soft(0.16), "--primary-contrast": contrast },
  };
}

/**
 * The stylesheet a widget page carries for a host colour. `:root:root` outranks the site's
 * `:root` and `html[data-theme]` token blocks whatever order they load in, and it sits on the root
 * because the price chart reads its colours from the root element. Only a parsed hex ever reaches
 * this string.
 */
export function accentStylesheet(accent: string | null): string {
  if (!accent || parseEmbedAccent(accent) !== accent) return "";
  const { light, dark } = accentTokens(accent);
  const block = (tokens: Record<string, string>) =>
    Object.entries(tokens)
      .map(([k, v]) => `${k}:${v};`)
      .join("");
  return `:root:root{${block(light)}}:root:root[data-theme="dark"]{${block(dark)}}@media (prefers-color-scheme: dark){:root:root:not([data-theme="light"]){${block(dark)}}}`;
}
