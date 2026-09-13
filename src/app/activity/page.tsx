import type { Metadata } from "next";
import { pageMeta } from "@/lib/page-meta";
import { ActivityView } from "@/components/activity/ActivityView";

export const metadata: Metadata = pageMeta({ title: "Activity", path: "/activity" });

export default function ActivityPage() {
  return <ActivityView />;
}
