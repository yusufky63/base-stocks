"use client";

import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import type { Allocation, PortfolioTemplate } from "@/domain/portfolio";
import type { CommunityBasket } from "@/domain/community";
import { apiGet, apiPost, ApiError, type AssetsResponse } from "@/lib/client-api";
import { useAssets, useConfigFlags, useTemplates } from "@/hooks/queries";
import { useAuth } from "@/hooks/useAuth";
import { Module, ModuleHeader, Skeleton, Button, Badge } from "@/components/ui/primitives";
import { Input } from "@/components/ui/Input";
import { AllocationEditor } from "./AllocationEditor";
import { PlanExecutor } from "./PlanExecutor";
import { AiIntentInput } from "./AiIntentInput";
import { TemplateCard } from "./TemplateCard";
import { validateAllocations } from "@/services/portfolio-service";
import { Dither } from "@/components/fx/Dither";
import { SignInButton } from "@/components/layout/SignInButton";

export function BuildView({ initialAssets, initialTemplates, embedded = false }: { initialAssets?: AssetsResponse; initialTemplates?: PortfolioTemplate[]; embedded?: boolean }) {
  const { data: assets } = useAssets(initialAssets);
  const { data: templates } = useTemplates(initialTemplates);
  const { data: flags } = useConfigFlags();
  const search = useSearchParams();
  const auth = useAuth();
  const cloneId = search.get("basket");
  const cloned = useQuery({ queryKey: ["basket", cloneId], queryFn: () => apiGet<{ basket: CommunityBasket }>(`/api/baskets/${cloneId}`), enabled: !!cloneId });
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [name, setName] = useState<string>("Custom portfolio");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState<"template" | "custom" | "ai">("custom");
  const [loadedClone, setLoadedClone] = useState<string | null>(null);
  const valid = validateAllocations(allocations).ok;

  // Clone a community basket into the editor once (URL param → state, adjust-on-prop-change pattern).
  const clonedBasket = cloned.data?.basket;
  if (clonedBasket && loadedClone !== clonedBasket.id) {
    setLoadedClone(clonedBasket.id);
    setAllocations(clonedBasket.allocations);
    setName(`${clonedBasket.name} (clone)`);
  }

  const publish = useMutation({
    mutationFn: async () => {
      await auth.ensureSignedIn();
      return apiPost<{ basket: CommunityBasket }>("/api/baskets", { name, description, allocations });
    },
  });

  return (
    <div className="flex flex-col gap-6">
      {!embedded && (
      <section className="hero-fx border border-line rounded-[8px] ticks bg-canvas overflow-hidden">
        <Dither className="fx-layer" pixelSize={6} opacity={0.28} speed={0.3} />
        <div className="fx-content p-6 md:p-10 grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-6 items-end">
          <div className="reveal">
            <div className="eyebrow mb-3">03 — Build</div>
            <h1 className="display text-[40px] md:text-[64px] leading-[0.92] uppercase">
              Build
              <br />a portfolio
              <br />
              <span className="text-primary">your way.</span>
            </h1>
          </div>
          <p className="max-w-[44ch] text-ink-secondary text-[15px] bg-canvas/80 rounded-[6px] p-2 -m-2">Arrange blocks with sliders or start from a template. Each purchase is a separate onchain trade you confirm.</p>
        </div>
      </section>
      )}

      {flags?.aiEnabled && (
        <Module>
          <ModuleHeader index="AI" title="Draft with AI" action={<Badge>optional · you review every draft</Badge>} />
          <div className="p-4">
            <AiIntentInput
              onIntent={(intent) => {
                setAllocations(intent.allocations);
                setName(intent.name || "AI draft");
                setSource("ai");
              }}
            />
          </div>
        </Module>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6 items-start">
        <Module ticks>
          <ModuleHeader index="A" title={name} action={<span className="font-mono text-[11px] text-ink-muted">{allocations.length} blocks{cloneId ? " · cloned" : ""}</span>} />
          <div className="p-4 flex flex-col gap-5">
            {assets ? (
              <AllocationEditor
                assets={assets.assets}
                value={allocations}
                onChange={(next) => {
                  setAllocations(next);
                  setSource("custom");
                }}
              />
            ) : (
              <Skeleton className="h-32" />
            )}
            <div className="border-t border-line pt-4 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="eyebrow">Publish to the community</span>
                <Badge>public</Badge>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Input label="Basket name" value={name} onChange={(e) => setName(e.target.value)} maxLength={48} />
                <Input label="One-line description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={280} placeholder="Why this mix?" />
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {auth.isSignedIn ? (
                  <Button size="sm" variant="secondary" loading={publish.isPending} disabled={!valid || name.trim().length < 3} onClick={() => publish.mutate()}>
                    <Upload size={14} strokeWidth={1.75} /> Publish basket
                  </Button>
                ) : (
                  <SignInButton label="Sign in to publish" />
                )}
                {publish.data && (
                  <Link href={`/baskets/${publish.data.basket.id}`} className="text-[13px] text-primary font-medium">
                    Published → view basket
                  </Link>
                )}
                {publish.error && <span className="text-[13px] text-danger-fg">{publish.error instanceof ApiError ? publish.error.message : "Could not publish."}</span>}
              </div>
              <p className="text-[12px] text-ink-muted">Published baskets are visible to everyone as templates (not recommendations) and can be voted on and cloned.</p>
            </div>
          </div>
        </Module>
        <Module className="lg:sticky lg:top-[72px]">
          <ModuleHeader index="B" title="Invest" />
          <div className="p-4">
            <PlanExecutor key={JSON.stringify(allocations)} allocations={allocations} source={source} disabled={!valid} />
          </div>
        </Module>
      </div>

      <Module>
        <ModuleHeader index="C" title="Templates" action={<Link href="/community" className="text-[13px] text-primary font-medium">Community baskets →</Link>} />
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {(templates ?? []).map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              assets={assets}
              onLoad={(tpl) => {
                setAllocations(tpl.allocations);
                setName(tpl.name);
                setSource("template");
                if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            />
          ))}
          {!templates && <Skeleton className="h-40" />}
        </div>
        <p className="px-4 py-3 text-[12px] text-ink-muted border-t border-line">Templates are starting points, not investment recommendations. Stocks that are not issued yet stay as USDC in the plan until Coinbase mints them.</p>
      </Module>
    </div>
  );
}


