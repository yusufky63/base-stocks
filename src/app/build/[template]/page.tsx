import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TemplateDetailView } from "@/components/build/TemplateDetailView";
import { StrategiesShell } from "@/components/strategies/StrategiesShell";
import { loadAssetsResponse } from "@/lib/server-data";
import { getRepos } from "@/db/repositories";

/** Rendered at most every 60 s and served from the cache between; the client refreshes prices itself. */
export const revalidate = 60;

type Props = { params: Promise<{ template: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { template } = await params;
  const t = await getRepos().templates.getBySlug(template).catch(() => null);
  return { title: t ? `${t.name} · Build` : "Template" };
}

export default async function TemplatePage({ params }: Props) {
  const { template } = await params;
  const [t, assets] = await Promise.all([getRepos().templates.getBySlug(template).catch(() => null), loadAssetsResponse()]);
  if (!t) notFound();
  return (
    <StrategiesShell tab="build" compact>
      <TemplateDetailView template={t} initialAssets={assets ?? undefined} />
    </StrategiesShell>
  );
}
