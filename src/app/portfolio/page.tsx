import type { Metadata } from "next";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { loadTemplates } from "@/lib/server-data";

export const metadata: Metadata = { title: "Portfolio" };

export default async function PortfolioPage() {
  const templates = await loadTemplates();
  return <PortfolioView initialTemplates={templates} />;
}
