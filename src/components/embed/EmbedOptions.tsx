"use client";

import { createContext, useCallback, useContext, type ReactNode } from "react";
import type { EmbedEligibility, EmbedSection } from "@/lib/embed";

/**
 * What the host of a widget chose: the sections it left out and who is asked the eligibility
 * question. Outside a widget nothing is hidden and only the server's rule asks, so the site's own
 * pages read the defaults and behave exactly as before.
 */
type EmbedChoices = { hide: readonly EmbedSection[]; eligibility: EmbedEligibility };

const EmbedContext = createContext<EmbedChoices>({ hide: [], eligibility: "region" });

export function EmbedOptionsProvider({ hide, eligibility, children }: EmbedChoices & { children: ReactNode }) {
  return <EmbedContext.Provider value={{ hide, eligibility }}>{children}</EmbedContext.Provider>;
}

export function useEmbedHidden(): (section: EmbedSection) => boolean {
  const { hide } = useContext(EmbedContext);
  return useCallback((section: EmbedSection) => hide.includes(section), [hide]);
}

export function useEmbedEligibility(): EmbedEligibility {
  return useContext(EmbedContext).eligibility;
}
