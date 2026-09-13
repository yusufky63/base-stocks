import type { MetadataRoute } from "next";
import { publicEnv } from "@/config/env";
import { CURATED_B20_ASSETS } from "@/lib/b20/registry";

/**
 * Product pages plus one entry per curated stock; discovered stocks join once curated.
 *
 * No `lastModified`: the old value was `new Date()` at build time, which told crawlers every page
 * changed with every deploy and was therefore ignored as a signal. `changeFrequency` carries what we
 * actually know about each page.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = publicEnv.appUrl.replace(/\/$/, "");
  const pages: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: "hourly", priority: 1 },
    { url: `${base}/markets`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${base}/build`, changeFrequency: "daily", priority: 0.8 },
    { url: `${base}/automate`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${base}/earn`, changeFrequency: "daily", priority: 0.7 },
    { url: `${base}/gifts`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${base}/pools`, changeFrequency: "daily", priority: 0.6 },
    { url: `${base}/community`, changeFrequency: "daily", priority: 0.6 },
    { url: `${base}/news`, changeFrequency: "hourly", priority: 0.6 },
    { url: `${base}/how-it-works`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${base}/docs`, changeFrequency: "weekly", priority: 0.5 },
    { url: `${base}/docs/reference`, changeFrequency: "weekly", priority: 0.4 },
    { url: `${base}/developers`, changeFrequency: "weekly", priority: 0.5 },
    { url: `${base}/stats`, changeFrequency: "hourly", priority: 0.5 },
    { url: `${base}/status`, changeFrequency: "daily", priority: 0.3 },
  ];
  const stocks: MetadataRoute.Sitemap = CURATED_B20_ASSETS.map((a) => ({
    url: `${base}/stocks/${a.address}`,
    changeFrequency: "hourly",
    priority: 0.8,
  }));
  return [...pages, ...stocks];
}
