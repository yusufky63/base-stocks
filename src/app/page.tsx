import { HomeView } from "@/components/home/HomeView";
import { loadAssetsResponse, loadTemplates } from "@/lib/server-data";

export default async function HomePage() {
  const [assets, templates] = await Promise.all([loadAssetsResponse(), loadTemplates()]);
  return <HomeView initialAssets={assets ?? undefined} initialTemplates={templates} />;
}
