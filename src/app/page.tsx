import { HomeView } from "@/components/home/HomeView";
import { loadAssetsResponse, loadTemplates } from "@/lib/server-data";

/** Rendered at most every 30 s and served from the cache between; the client refreshes prices itself. */
export const revalidate = 30;

export default async function HomePage() {
  const [assets, templates] = await Promise.all([loadAssetsResponse(), loadTemplates()]);
  return <HomeView initialAssets={assets ?? undefined} initialTemplates={templates} />;
}
