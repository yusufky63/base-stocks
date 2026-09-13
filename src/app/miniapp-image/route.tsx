import { shareCard } from "@/lib/share-card";

/**
 * The share card at 3:2 (1200×800), the ratio the mini app embed (`fc:miniapp` / `fc:frame`)
 * asks for. Hosts crop a 1.91:1 Open Graph image to fit, which cut the headline and the coins.
 * Static, so it can be cached for a day.
 */
export const revalidate = 86_400;

export function GET() {
  const image = shareCard({ width: 1200, height: 800 });
  image.headers.set("cache-control", "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800");
  return image;
}
