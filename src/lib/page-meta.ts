import type { Metadata } from "next";

const SITE = "BaseStocks";
const DEFAULT_DESCRIPTION = "Trade tokenized stocks, build personalized portfolios, and put supported assets to work on Base.";

/**
 * Per-page metadata with the fields Next does not inherit.
 *
 * The root layout's `openGraph` block is copied to a page whole (nested metadata is replaced,
 * not merged), so every page used to share the home page's `og:url` and `og:title`, and none had
 * a canonical URL: a link to /markets previewed as the home page, and `/stocks/0xB2…` and
 * `/stocks/0xb2…` were two pages to a crawler. This builds the page's own set from its title,
 * description and path; images still come from the segment's `opengraph-image` file.
 */
export function pageMeta(input: { title: string; description?: string; path: string; noindex?: boolean; other?: Record<string, string> }): Metadata {
  const description = input.description ?? DEFAULT_DESCRIPTION;
  const full = `${input.title} · ${SITE}`;
  return {
    title: input.title,
    description,
    alternates: { canonical: input.path },
    openGraph: { type: "website", siteName: SITE, locale: "en_US", url: input.path, title: full, description },
    twitter: { card: "summary_large_image", creator: "@codexsha", title: full, description },
    ...(input.noindex ? { robots: { index: false, follow: false } } : {}),
    ...(input.other ? { other: input.other } : {}),
  };
}
