"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, type AutomationListResponse, type AutomationRuleDTO } from "@/lib/client-api";
import { useAuth } from "./useAuth";

export const AUTOMATION_QUERY_KEY = "automation";

/**
 * The signed-in wallet's automation rules, split the way the product thinks about them: plans that
 * buy on a schedule, and the one target mix the portfolio measures drift against. One query feeds
 * the Automate page, the Portfolio card and the Rebalance tab, so they can never disagree.
 */
export function useAutomation() {
  const auth = useAuth();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: [AUTOMATION_QUERY_KEY, auth.signedInAs ?? ""],
    queryFn: () => apiGet<AutomationListResponse>("/api/automation"),
    enabled: auth.isSignedIn,
    staleTime: 20_000,
    refetchInterval: 60_000,
  });
  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: [AUTOMATION_QUERY_KEY] }), [qc]);
  const rules: AutomationRuleDTO[] = query.data?.rules ?? [];
  const plans = rules.filter((r) => r.type !== "drift-alert");
  const target = rules.find((r) => r.type === "drift-alert" && r.status === "active") ?? null;
  return {
    ...query,
    rules,
    plans,
    active: plans.filter((p) => p.status === "active"),
    due: plans.filter((p) => p.due),
    target,
    autoInvest: query.data?.autoInvest ?? null,
    signedIn: auth.isSignedIn,
    invalidate,
  };
}
