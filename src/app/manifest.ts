import type { MetadataRoute } from "next";

/**
 * The web app manifest: what lets a phone or desktop browser offer "Add to Home Screen" and open
 * BaseStocks as its own window. Static — Next caches it once per build — and deliberately without a
 * service worker: an app that quotes live prices and files transactions must never serve a cached
 * page as if it were current, and a manifest alone is enough for installation in every current
 * browser.
 *
 * `start_url` carries a query so analytics (and the mini-app detection) can tell an installed
 * launch from a tab. The maskable icons keep the mark inside the safe zone Android crops to.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "BaseStocks — Stocks, built for onchain",
    short_name: "BaseStocks",
    description: "Trade Coinbase Tokenized Stocks, build personalized portfolios, and put idle USDC to work on Base.",
    id: "/",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#0370fd",
    categories: ["finance"],
    lang: "en",
    icons: [
      { src: "/brand/pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/pwa-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/brand/pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Markets", short_name: "Markets", url: "/markets?source=pwa", icons: [{ src: "/brand/pwa-192.png", sizes: "192x192" }] },
      { name: "Portfolio", short_name: "Portfolio", url: "/portfolio?source=pwa", icons: [{ src: "/brand/pwa-192.png", sizes: "192x192" }] },
      { name: "Gift a stock", short_name: "Gift", url: "/gift?source=pwa", icons: [{ src: "/brand/pwa-192.png", sizes: "192x192" }] },
    ],
  };
}
