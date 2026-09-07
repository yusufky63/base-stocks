import type { MetadataRoute } from "next";
import { publicEnv } from "@/config/env";

/**
 * Crawlers index the product pages; the admin panel and secret-bearing claim links stay out.
 *
 * `/api/` is still closed — those routes serve the app's own screens and have no contract with
 * anyone else — but `/api/v1/` is the published API and is deliberately open, alongside the
 * `llms.txt` index that describes it. Telling an assistant not to read the endpoint written for
 * it would be a strange thing to do.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/api/v1/", "/llms.txt"],
        disallow: ["/api/", "/admin", "/gifts/claim/"],
      },
    ],
    sitemap: `${publicEnv.appUrl}/sitemap.xml`,
  };
}
