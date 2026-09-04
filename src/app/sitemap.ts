import type { MetadataRoute } from "next";
import { publicEnv } from "@/config/env";
import { CURATED_B20_ASSETS } from "@/lib/b20/registry";

/** Product pages plus one entry per curated stock; discovered stocks join once curated. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = publicEnv.appUrl.replace(/\/$/, "");
  const now = new Date();
  const pages: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: now, changeFrequency: "hourly", priority: 1 },
    { url: `${base}/markets`, lastModified: now, changeFrequency: "hourly", priority: 0.9 },
    { url: `${base}/build`, lastModified: now, changeFrequency: "daily", priority: 0.8 },
    { url: `${base}/earn`, lastModified: now, changeFrequency: "daily", priority: 0.7 },
    { url: `${base}/gifts`, lastModified: now, changeFrequency: "weekly", priority: 0.6 },
    { url: `${base}/pools`, lastModified: now, changeFrequency: "daily", priority: 0.6 },
    { url: `${base}/community`, lastModified: now, changeFrequency: "daily", priority: 0.6 },
    { url: `${base}/news`, lastModified: now, changeFrequency: "hourly", priority: 0.6 },
    { url: `${base}/how-it-works`, lastModified: now, changeFrequency: "weekly", priority: 0.7 },
    { url: `${base}/docs`, lastModified: now, changeFrequency: "weekly", priority: 0.5 },
    { url: `${base}/status`, lastModified: now, changeFrequency: "daily", priority: 0.3 },
  ];
  const stocks: MetadataRoute.Sitemap = CURATED_B20_ASSETS.map((a) => ({
    url: `${base}/stocks/${a.address}`,
    lastModified: now,
    changeFrequency: "hourly",
    priority: 0.8,
  }));
  return [...pages, ...stocks];
}
