import type { MetadataRoute } from "next";
import { publicEnv } from "@/config/public-env";
import { allAssetEntries } from "@/lib/b20/registry";
import { ensureDiscoveredRegistry } from "@/services/b20-asset-service";

/**
 * Product pages plus one entry per stock in the registry: the bootstrap list and every discovered
 * stock that passed verification. Regenerated hourly so a new listing reaches crawlers without a deploy.
 *
 * No `lastModified`: the old value was `new Date()` at build time, which told crawlers every page
 * changed with every deploy and was therefore ignored as a signal. `changeFrequency` carries what we
 * actually know about each page.
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await ensureDiscoveredRegistry();
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
    { url: `${base}/widgets`, changeFrequency: "weekly", priority: 0.5 },
    { url: `${base}/stats`, changeFrequency: "hourly", priority: 0.5 },
    { url: `${base}/status`, changeFrequency: "daily", priority: 0.3 },
  ];
  const stocks: MetadataRoute.Sitemap = allAssetEntries().map((a) => ({
    url: `${base}/stocks/${a.address}`,
    changeFrequency: "hourly",
    priority: 0.8,
  }));
  return [...pages, ...stocks];
}
