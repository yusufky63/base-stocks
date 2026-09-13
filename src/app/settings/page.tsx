import type { Metadata } from "next";
import { pageMeta } from "@/lib/page-meta";
import { SettingsView } from "@/components/settings/SettingsView";

export const metadata: Metadata = pageMeta({ title: "Settings", path: "/settings" });

export default function SettingsPage() {
  return <SettingsView />;
}
