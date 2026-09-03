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
import { Module, ModuleHeader, Skeleton, Button, cx } from "@/components/ui/primitives";
import { Collapsible } from "@/components/ui/Collapsible";
import { Input } from "@/components/ui/Input";
import { AllocationEditor } from "./AllocationEditor";
import { PlanExecutor } from "./PlanExecutor";
import { AiIntentInput } from "./AiIntentInput";
import { TemplateCard } from "./TemplateCard";
import { sortTemplatesByLiveness } from "@/lib/templates";
import { validateAllocations } from "@/services/portfolio-service";
import { Dither } from "@/components/fx/Dither";
import { SignInButton } from "@/components/layout/SignInButton";

type StartMode = "template" | "ai" | "scratch";

/**
 * Build in three moves: pick a starting point (template, AI draft or from scratch), adjust the
 * basket in the editor, invest with live quotes. Publishing is tucked under the editor.
 */
export function BuildView({ initialAssets, initialTemplates, embedded = false }: { initialAssets?: AssetsResponse; initialTemplates?: PortfolioTemplate[]; embedded?: boolean }) {
  const { data: assets } = useAssets(initialAssets);
  const { data: templates } = useTemplates(initialTemplates);
  const { data: flags } = useConfigFlags();
  const search = useSearchParams();
  const auth = useAuth();
  const cloneId = search.get("basket");
  const cloned = useQuery({ queryKey: ["basket", cloneId], queryFn: () => apiGet<{ basket: CommunityBasket }>(`/api/baskets/${cloneId}`), enabled: !!cloneId });
  const [mode, setMode] = useState<StartMode>("ai");
  /** AI is the default start; when the operator disabled it the templates take its place. */
  const activeMode: StartMode = mode === "ai" && flags?.aiEnabled === false ? "template" : mode;
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

  const load = (next: Allocation[], label: string, from: "template" | "ai") => {
    setAllocations(next);
    setName(label);
    setSource(from);
    if (typeof document !== "undefined") document.getElementById("basket-editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const MODES: Array<{ id: StartMode; label: string; hint: string }> = [
    { id: "ai", label: "AI draft", hint: "describe a theme" },
    { id: "template", label: "Template", hint: "ready-made mix, live stocks first" },
    { id: "scratch", label: "From scratch", hint: "pick stocks yourself" },
  ];

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
            <p className="max-w-[44ch] text-ink-secondary text-[15px] bg-canvas/80 rounded-[6px] p-2 -m-2">Pick a start, adjust the mix, invest. Each purchase is a trade you confirm.</p>
          </div>
        </section>
      )}

      <Module>
        <ModuleHeader
          index="A"
          title="Start with"
          action={
            <div role="tablist" aria-label="Starting point" className="flex gap-1 p-1 rounded-[8px] bg-surface-muted">
              {MODES.filter((m) => m.id !== "ai" || flags?.aiEnabled !== false).map((m) => (
                <button key={m.id} role="tab" aria-selected={activeMode === m.id} onClick={() => setMode(m.id)} className={cx("h-8 px-3 rounded-[6px] text-[12px] font-medium transition-fast whitespace-nowrap", activeMode === m.id ? "bg-canvas border border-line text-primary" : "text-ink-secondary hover:text-ink")} title={m.hint}>
                  {m.label}
                </button>
              ))}
            </div>
          }
        />
        <div className="p-4">
          {activeMode === "template" && (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {sortTemplatesByLiveness(templates ?? [], assets).map((t) => (
                <TemplateCard key={t.id} template={t} assets={assets} compact onLoad={(tpl) => load(tpl.allocations, tpl.name, "template")} />
              ))}
              {!templates && <Skeleton className="h-36" />}
              {templates && templates.length === 0 && <p className="text-[13px] text-ink-secondary">No templates yet.</p>}
            </div>
          )}
          {activeMode === "ai" && <AiIntentInput onIntent={(intent) => load(intent.allocations, intent.name || "AI draft", "ai")} />}
          {activeMode === "scratch" && <p className="text-[13px] text-ink-secondary">Add stocks and a USDC share in the basket below; weights must total 100%.</p>}
        </div>
      </Module>

      <div id="basket-editor" className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6 items-start scroll-mt-24">
        <Module ticks>
          <ModuleHeader index="B" title={name} action={<span className="font-mono text-[11px] text-ink-muted">{allocations.length} blocks{cloneId ? " · cloned" : ""}</span>} />
          <div className="p-4 flex flex-col gap-4">
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
            <Collapsible title="Publish this basket to the community">
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Input label="Basket name" value={name} onChange={(e) => setName(e.target.value)} maxLength={48} />
                  <Input label="One-line description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={280} placeholder="Why this mix?" />
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {auth.isSignedIn ? (
                    <Button size="sm" variant="secondary" loading={publish.isPending} disabled={!valid || name.trim().length < 3} onClick={() => publish.mutate()}>
                      <Upload size={14} strokeWidth={1.75} /> Publish
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
                  <span className="text-[12px] text-ink-muted">Public, votable, clonable. A template, not a recommendation.</span>
                </div>
              </div>
            </Collapsible>
          </div>
        </Module>
        <Module className="lg:sticky lg:top-[72px]">
          <ModuleHeader index="C" title="Invest" />
          <div className="p-4">
            <PlanExecutor key={JSON.stringify(allocations)} allocations={allocations} source={source} disabled={!valid} />
          </div>
        </Module>
      </div>

      <p className="text-[12px] text-ink-muted">
        Templates and drafts are starting points, not investment recommendations. Stocks not issued yet stay as USDC in the plan until Coinbase mints them.{" "}
        <Link href="/community" className="text-primary font-medium">
          Community baskets →
        </Link>
      </p>
    </div>
  );
}
