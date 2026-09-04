"use client";

/**
 * The handful of things that behave differently inside a mini app host, kept in one place.
 *
 * The SDK is imported once and shared. It is not a lazy win: the wagmi host connector imports it
 * statically, so it is already in the first-load bundle (~24 KB gzipped) and already evaluated on
 * every page. Deferring it here only keeps the boundary honest — nothing calls into the host until
 * something in the app actually asks for a host action.
 */
type MiniAppSdk = (typeof import("@farcaster/miniapp-sdk"))["sdk"];

let pending: Promise<MiniAppSdk> | null = null;

/** Loaded once and shared; the host is a singleton and so is the channel to it. */
export function miniAppSdk(): Promise<MiniAppSdk> {
  pending ??= import("@farcaster/miniapp-sdk").then((m) => m.sdk);
  return pending;
}

/**
 * Open a link outside the mini app.
 *
 * Inside a host, a plain `target="_blank"` is at best ignored and at worst replaces the mini app
 * with the destination and no way back. The host has to be asked to do it.
 */
export async function openExternal(url: string): Promise<boolean> {
  try {
    const sdk = await miniAppSdk();
    await sdk.actions.openUrl(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hand the user a pre-filled cast with this page embedded.
 *
 * This is what "share" should mean inside the Base app: the link is not copied to a clipboard and
 * pasted somewhere, it goes straight into a composer with the mini app card already attached.
 * Returns false when the host refuses or the user backs out, so the caller can fall back.
 */
export async function composeCast(text: string, url: string): Promise<boolean> {
  try {
    const sdk = await miniAppSdk();
    await sdk.actions.composeCast({ text, embeds: [url] });
    return true;
  } catch {
    return false;
  }
}

/** Ask the host to save BStocks to the user's apps. Rejection is an ordinary answer, not an error. */
export async function addMiniApp(): Promise<boolean> {
  try {
    const sdk = await miniAppSdk();
    await sdk.actions.addMiniApp();
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a clicked link should be handed to the host, and the URL to hand it.
 *
 * Only links that actually leave the site: an in-app route resolves to this same origin and must
 * stay in the frame, and `mailto:`, `tel:` and the like are the host's business by their scheme,
 * not ours. A href the browser cannot parse is left exactly as it was.
 */
export function externalTarget(href: string, origin: string): string | null {
  try {
    const url = new URL(href, origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin === new URL(origin).origin ? null : url.href;
  } catch {
    return null;
  }
}
