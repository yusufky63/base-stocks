import { publicEnv } from "@/config/env";

/**
 * The `fc:miniapp` embed tag: what turns a shared BStocks link into a launchable card inside the
 * Base app and other Farcaster clients, instead of a plain grey link preview.
 *
 * It is deliberately per-page. A gift pool link that opens the *pool* is the whole point of
 * sharing one — landing every visitor on the home page would throw away the context the sender
 * meant to pass on. So `url` is the page's own URL, and the host launches straight into it.
 */
const APP_URL = publicEnv.appUrl.replace(/\/$/, "");

/** Hosts render the button as a single line; the spec caps it and long titles are simply cut. */
const MAX_BUTTON_TITLE = 32;

export interface MiniAppEmbed {
  /** Where the launch button lands. Defaults to the home page. */
  url?: string;
  /** 3:2 card image above the button. Defaults to the site's share card drawn at that ratio. */
  imageUrl?: string;
  /** Label on the launch button, 32 characters at most. */
  buttonTitle?: string;
}

function embedJson(type: "launch_miniapp" | "launch_frame", { url, imageUrl, buttonTitle }: MiniAppEmbed): string {
  return JSON.stringify({
    version: "1",
    imageUrl: imageUrl ?? `${APP_URL}/miniapp-image`,
    button: {
      title: (buttonTitle ?? "Open BStocks").slice(0, MAX_BUTTON_TITLE),
      action: {
        type,
        name: "BStocks",
        url: url ?? `${APP_URL}/`,
        splashImageUrl: `${APP_URL}/brand/splash-200.png`,
        splashBackgroundColor: "#0370fd",
      },
    },
  });
}

/**
 * Both tags, for Next's `metadata.other`. `fc:frame` carries the same payload under the older name
 * so clients that have not moved to `fc:miniapp` still render a launch button rather than nothing.
 */
export function miniAppMeta(embed: MiniAppEmbed = {}): Record<string, string> {
  return {
    "fc:miniapp": embedJson("launch_miniapp", embed),
    "fc:frame": embedJson("launch_frame", embed),
  };
}

/** Base app id (Builder Codes): ties this web app to the registered Base project for attribution. */
const BASE_APP_ID = process.env.NEXT_PUBLIC_BASE_APP_ID || "6a98cc686e87922b5d1d4597";

/**
 * The full `metadata.other` block for a page.
 *
 * Next merges metadata field by field, so a page that sets `other` replaces the layout's `other`
 * wholesale — the Base app id would silently go missing from exactly the pages worth sharing.
 * Going through here keeps it attached.
 */
export function appMeta(embed: MiniAppEmbed = {}): Record<string, string> {
  return { "base:app_id": BASE_APP_ID, ...miniAppMeta(embed) };
}

/** Absolute URL for a path on this site, which the embed tags require. */
export function appUrl(path: string): string {
  return `${APP_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
