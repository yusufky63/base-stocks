import type { MetadataRoute } from "next";
import { publicEnv } from "@/config/env";

/** Crawlers index the product pages; APIs, the admin panel and secret-bearing claim links stay out. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/admin", "/gifts/claim/"],
      },
    ],
    sitemap: `${publicEnv.appUrl}/sitemap.xml`,
  };
}
